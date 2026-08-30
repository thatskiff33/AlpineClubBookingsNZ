import { formatDateOnly } from "@/lib/date-only";
import { ApiError } from "@/lib/api-error";

/**
 * The complete, explicit soft-policy allowlist (#2363).
 *
 * A code not present here is structurally unable to enter exception review.
 * In particular capacity/full-lodge, invalid/past dates, authentication,
 * subscription/membership eligibility, duplicate member-night, payment,
 * privacy and data-integrity failures remain hard stops.
 */
export const POLICY_EXCEPTION_REASON_CODES = [
  "MINIMUM_STAY",
  "ADULT_MEMBER_HOSTING_REQUIRED",
  "PAID_UP_ADULT_MEMBER_REQUIRED",
] as const;

export type PolicyExceptionReasonCode =
  (typeof POLICY_EXCEPTION_REASON_CODES)[number];

export const HARD_STOP_BOOKING_FAILURE_CODES = [
  "CAPACITY_EXCEEDED",
  "INVALID_DATES",
  "PAST_DATES",
  "AUTHENTICATION_REQUIRED",
  "SUBSCRIPTION_REQUIRED",
  "GUEST_SUBSCRIPTION_REQUIRED",
  "MEMBERSHIP_TYPE_BLOCKS_BOOKING",
  "MEMBER_GUEST_NOT_ADDABLE",
  "BOOKING_MEMBER_NIGHT_CONFLICT",
  "PAYMENT_REQUIRED",
  "PRIVACY_RESTRICTION",
  "DATA_INTEGRITY_FAILURE",
] as const;

export type HardStopBookingFailureCode =
  (typeof HARD_STOP_BOOKING_FAILURE_CODES)[number];

export const POLICY_EXCEPTION_CAPACITY_MODES = ["HOLD", "NO_HOLD"] as const;
export type PolicyExceptionCapacityMode =
  (typeof POLICY_EXCEPTION_CAPACITY_MODES)[number];

export type ResolvedPolicyScope =
  | {
      kind: "CLUB_WIDE";
      /** The policy row itself is club-wide. */
      lodgeId: null;
      /** The lodge for which this club-wide row was resolved. */
      effectiveLodgeId: string;
    }
  | {
      kind: "LODGE";
      /** The lodge-specific override row and effective lodge are identical. */
      lodgeId: string;
      effectiveLodgeId: string;
    };

type PolicyIdentity = {
  policyId: string;
  policyVersion: number;
  policyName: string;
};

type FrozenExceptionFacts = PolicyIdentity & {
  resolvedScope: ResolvedPolicyScope;
  /** Sorted, unique New Zealand lodge-night values (YYYY-MM-DD). */
  affectedNights: string[];
  exceptionEligible: true;
  capacityMode: PolicyExceptionCapacityMode;
  /** Plain-language rendering; structured fields remain authoritative. */
  message: string;
};

export type MinimumStayPolicyExceptionViolation = FrozenExceptionFacts & {
  reasonCode: "MINIMUM_STAY";
  /** Compatibility display fields; requirements remains the canonical shape. */
  triggerDay: string;
  minimumNights: number;
  actualNights: number;
  requirements: {
    kind: "MINIMUM_STAY";
    minimumNights: number;
    actualNights: number;
    /** Sorted numeric weekdays, 0=Sunday ... 6=Saturday. */
    triggerDays: number[];
  };
};

/**
 * One non-member guest on one NZ lodge night that no adult member covers.
 *
 * `guestRef` identifies the guest ROW where one exists (`BookingGuest.id`) and
 * falls back to the pre-persist position `guest:<index>` on the create path,
 * which evaluates a party that has no rows yet. Both forms are stable within one
 * snapshot, which is all the comparison in `adultMemberHostingReviewChanged`
 * needs; neither is a durable handle to be dereferenced later.
 */
export type UncoveredGuestNight = {
  guestRef: string;
  guestName: string;
  /** NZ lodge night, YYYY-MM-DD. */
  night: string;
};

/** The adult members whose participant rows cover one night, if any. */
export type QualifyingHostsForNight = {
  night: string;
  /** Sorted Member ids. Empty means the night has no qualifying host. */
  memberIds: string[];
  /**
   * Which enabled host scopes supplied this night's cover (#2569 §11: store the
   * scope that supplied coverage, not just the fact of it). Sorted through
   * `ADULT_MEMBER_HOST_SCOPES`, so the snapshot is deterministic.
   *
   * Optional: a snapshot frozen before #2569 has no scope information, and absent
   * reads as the only scope that existed then, `SAME_BOOKING`.
   */
  coveredByScopes?: AdultMemberHostScope[];
};

/**
 * The ways a club may let an adult member supply coverage (#2569 §2).
 *
 * INDEPENDENT and combined with OR: a club or lodge enables either or both, and a
 * non-member guest-night is compliant where AT LEAST ONE enabled scope supplies
 * eligible adult-member coverage for that exact night. Different nights of one
 * booking may be covered by different scopes and by different members.
 *
 *  - `SAME_BOOKING` — an eligible adult member staying on the same booking. The
 *    pre-#2569 rule, preserved verbatim as one available scope (§4) and the
 *    built-in default, so an upgrade moves no club's behaviour (§15).
 *  - `SAME_BOOKING_OWNER` — an eligible adult member attending another eligible
 *    booking whose `Booking.memberId` is EXACTLY the same, at the same lodge on
 *    the same night (#2576). One account's own split bookings covering each other,
 *    and nothing wider: not `createdById`, not a shared email, not a Family Group
 *    link, not `parentBookingId` alone, and never another account's booking.
 *  - `SAME_GROUP_TRIP` — an eligible adult member attending another eligible
 *    booking in the SAME GROUP TRIP, at the same lodge on the same night (#3037,
 *    epic #2943). The first scope that can cross accounts, which is why it is
 *    OFF by default and why the identity it turns on is narrow and canonical:
 *    `GroupBooking.organiserBookingId` and `GroupBookingJoin.bookingId`, resolved
 *    in one place (`group-trip-identity.ts`) and NEVER `Booking.parentBookingId`,
 *    which is a different relationship and would produce wrong sibling sets.
 *
 * APPENDED, NEVER REORDERED. This list is iterated to sort `coveredByScopes` and
 * `enabledHostScopes` onto a frozen violation snapshot, and two evaluations of the
 * same facts must produce byte-identical snapshots — so inserting a value ahead of
 * an existing one would rewrite the bytes of snapshots nobody edited.
 *
 * THREE SCOPES NOW; TWO OF THE ORIGINAL SPEC'S ARE STILL REMOVED (owner decisions,
 * 3 Aug 2026). The #2569 spec named three and both of the others were settled out
 * of the product model before any of them shipped:
 *
 *  - `ANY_MEMBER_AT_LODGE` is REMOVED (#2575). Letting one booking become
 *    compliant because an unrelated adult member happens to be staying at the same
 *    lodge creates dependencies between otherwise unrelated bookings, and the
 *    owner's decision is that the product should not allow it.
 *  - `NOMINATED_HOST` is REPLACED (#2576) by `SAME_BOOKING_OWNER`. The narrower
 *    same-account rule answers the cross-booking case the club actually has (a
 *    member with two bookings at one lodge) without a nomination, invitation,
 *    acceptance or host-search workflow.
 *
 * Neither is deferred or dormant: there is deliberately no hidden, refused or
 * reserved value for either anywhere in the database or the application, so a
 * future lane cannot switch one on by editing a registry. Rebuilding either would
 * mean re-deciding it. `SAME_GROUP_TRIP` is not a revival of either: it is not
 * "any member at the lodge" (an unrelated member at the same lodge still supplies
 * nothing) and it is not a nomination workflow (there is no invitation, acceptance
 * or host search — the Group Trip already exists as a real, joined relationship).
 *
 * Declared here, beside the violation shape that reports them, so the evaluator,
 * the policy row, the admin route and the frozen snapshot all name one list.
 */
export const ADULT_MEMBER_HOST_SCOPES = [
  "SAME_BOOKING",
  "SAME_BOOKING_OWNER",
  "SAME_GROUP_TRIP",
] as const;

export type AdultMemberHostScope = (typeof ADULT_MEMBER_HOST_SCOPES)[number];

/**
 * The CONSEQUENCE that produced a hosting violation — the club's second policy
 * dimension, frozen onto the snapshot beside the rule it broke.
 *
 * Recorded rather than inferred because the SAME violation means two different
 * things: under `ADMIN_REVIEW_REQUIRED` the booking was made and awaits an
 * officer, under `ENFORCED` it was refused and exists only as an exception
 * request. An officer reading a stored snapshot, and a member reading a refusal,
 * both need to know which happened, and neither can work it out from the policy
 * row later — the club may have changed the setting since.
 */
export type AdultMemberHostingConsequence = "ADMIN_REVIEW_REQUIRED" | "ENFORCED";

/**
 * Contract reserved by #2363 for #2364's evaluator, now implemented by
 * `evaluateAdultMemberHostingWithPolicy` (`policies/adult-member-hosting.ts`).
 *
 * `requirements` carries the EVIDENCE as well as the rule, because the whole
 * point of this violation is that it names which guest is uncovered on which
 * night — a bare count would leave an admin unable to see what to fix, and would
 * leave the reconciler unable to tell "the same hazard" from "a materially
 * different one". Every list is sorted so two evaluations of the same facts
 * produce byte-identical snapshots.
 */
export type AdultMemberHostingPolicyExceptionViolation = FrozenExceptionFacts & {
  reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED";
  /**
   * What the club's setting does about this violation (#2569 §1). Optional so a
   * snapshot frozen before #2569 still parses; absent means the only consequence
   * that existed then, `ADMIN_REVIEW_REQUIRED`.
   */
  consequence?: AdultMemberHostingConsequence;
  requirements: {
    kind: "ADULT_MEMBER_HOSTING";
    requiredAdultMemberParticipantsPerGuestNight: 1;
    uncoveredNonMemberGuestNights: number;
    /** Sorted by night then guestRef. */
    uncovered: UncoveredGuestNight[];
    /** One entry per affected night, in night order. */
    qualifyingHostsByNight: QualifyingHostsForNight[];
    /**
     * Which adult members the club lets count, at this lodge, at the moment of
     * evaluation (#2569 §17: a member told their booking is uncovered must also
     * be told what would cover it). Sorted, and always non-empty for an active
     * policy — the resolver refuses an active policy with no scopes.
     *
     * Optional for the same reason `consequence` is: a pre-#2569 snapshot has no
     * scope set, and absent reads as the built-in default, same-booking only.
     */
    enabledHostScopes?: AdultMemberHostScope[];
  };
};

/**
 * The party has no paid-up adult member on it, under the club's
 * `NON_MEMBER_PRICING` subscription-lockout policy (#2543).
 *
 * A PARTY-LEVEL rule, unlike its per-night neighbour above, because that is
 * literally the club's rule: "there still has to be at least one paid-up adult
 * member on the booking". Per-night coverage of non-member guests remains
 * `ADULT_MEMBER_HOSTING_REQUIRED`'s job, and the two compose — under
 * `NON_MEMBER_PRICING` an unpaid member also stops satisfying that rule's host
 * predicate, so a party can trip both and an admin sees both.
 *
 * `requirements` deliberately carries COUNTS AND NO IDENTITIES. Every other
 * field of this shape is rendered straight back to the member who was refused,
 * and naming which member is unpaid would turn a booking refusal into a
 * financial-status oracle — the same disclosure the D-8 cross-family collapse
 * closed on the member-guest paths. An admin does not need it either: the queue
 * shows the whole proposed party and the live subscription screens are one click
 * away.
 */
export type PaidUpAdultMemberPolicyExceptionViolation = FrozenExceptionFacts & {
  reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED";
  requirements: {
    kind: "PAID_UP_ADULT_MEMBER";
    /** The rule is satisfied by one; stated so the shape reads as a threshold. */
    requiredPaidUpAdultMembers: 1;
    /** How many participants the club is repricing as non-members tonight. */
    repricedUnpaidMemberCount: number;
    /** Party size, so an admin can see the refusal in proportion. */
    participantCount: number;
  };
};

export type PolicyExceptionViolation =
  | MinimumStayPolicyExceptionViolation
  | AdultMemberHostingPolicyExceptionViolation
  | PaidUpAdultMemberPolicyExceptionViolation;

export interface AggregatedPolicyExceptions {
  violations: PolicyExceptionViolation[];
  /** Null when there is nothing to review; otherwise HOLD wins if any row holds. */
  capacityMode: PolicyExceptionCapacityMode | null;
}

/**
 * Typed transport for mutation paths that still hard-block minimum-stay
 * violations. #2365 may add durable review; #2363 only preserves the frozen
 * snapshot and aggregate alongside the legacy prose and HTTP 400.
 */
export class MinimumStayPolicyViolationError extends ApiError {
  readonly code = "MINIMUM_STAY_VIOLATION";
  readonly violations: MinimumStayPolicyExceptionViolation[];
  readonly exceptionReview: AggregatedPolicyExceptions;

  constructor(
    public readonly details: string,
    violations: MinimumStayPolicyExceptionViolation[],
  ) {
    super(details, 400);
    this.name = "MinimumStayPolicyViolationError";
    this.exceptionReview = aggregatePolicyExceptionViolations(violations);
    this.violations = this.exceptionReview
      .violations as MinimumStayPolicyExceptionViolation[];
  }
}

export function isPolicyExceptionReasonCode(
  value: string,
): value is PolicyExceptionReasonCode {
  return (POLICY_EXCEPTION_REASON_CODES as readonly string[]).includes(value);
}

export function isHardStopBookingFailureCode(
  value: string,
): value is HardStopBookingFailureCode {
  return (HARD_STOP_BOOKING_FAILURE_CODES as readonly string[]).includes(value);
}

/** Canonicalise date-only nights once, at the policy boundary. */
export function canonicalAffectedNights(nights: Date[]): string[] {
  return [...new Set(nights.map(formatDateOnly))].sort();
}

/** Deterministic order makes API snapshots, review fingerprints and tests stable. */
export function sortPolicyExceptionViolations(
  violations: PolicyExceptionViolation[],
): PolicyExceptionViolation[] {
  return [...violations].sort((a, b) =>
    a.reasonCode.localeCompare(b.reasonCode) ||
    a.policyId.localeCompare(b.policyId) ||
    a.policyVersion - b.policyVersion ||
    a.affectedNights.join(",").localeCompare(b.affectedNights.join(",")),
  );
}

export function aggregatePolicyExceptionViolations(
  violations: PolicyExceptionViolation[],
): AggregatedPolicyExceptions {
  for (const violation of violations) {
    if (!isPolicyExceptionReasonCode(violation.reasonCode)) {
      throw new Error(
        `Non-allowlisted booking failure cannot enter policy exception review: ${violation.reasonCode}`,
      );
    }
  }
  const ordered = sortPolicyExceptionViolations(violations);
  return {
    violations: ordered,
    capacityMode:
      ordered.length === 0
        ? null
        : ordered.some((violation) => violation.capacityMode === "HOLD")
          ? "HOLD"
          : "NO_HOLD",
  };
}
