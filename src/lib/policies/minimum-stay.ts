import {
  calendarDateOfDateOnlyInstant,
  calendarDayOfWeek,
} from "@/lib/club-time";
import { getStayNights } from "./pricing";
import {
  aggregatePolicyExceptionViolations,
  canonicalAffectedNights,
  type MinimumStayPolicyExceptionViolation,
  type PolicyExceptionCapacityMode,
} from "@/lib/booking-policy-exceptions";

export type MinimumStayViolation = MinimumStayPolicyExceptionViolation;

export interface MinimumStayPolicyLike {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  triggerDays: number[];
  minimumNights: number;
  lodgeId: string | null;
  version: number;
  capacityMode: PolicyExceptionCapacityMode;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayName(day: number): string {
  return DAY_NAMES[day] ?? `Day ${day}`;
}

/**
 * Check if two date ranges overlap.
 * Range A: [aStart, aEnd], Range B: [bStart, bEnd] (all inclusive).
 */
function dateRangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function getMinimumStayViolations(
  checkIn: Date,
  checkOut: Date,
  policies: MinimumStayPolicyLike[],
  effectiveLodgeId: string,
): MinimumStayViolation[] {
  const nights = getStayNights(checkIn, checkOut);
  const nightCount = nights.length;

  if (nightCount === 0 || policies.length === 0) {
    return [];
  }

  const violations: MinimumStayViolation[] = [];

  for (const policy of policies) {
    // Date-only values are UTC midnight by contract, so the weekday belongs to
    // the DAY they encode. The kernel decodes that day and answers from its
    // calendar text, so no host getter decides which weekday activates a policy
    // (CT-4, #2870). `getStayNights` builds every night through
    // `normalizeBookingDate`, which refuses a value it cannot decode, so the
    // decode here cannot throw.
    const affected = nights.filter((night) => {
      const dow = calendarDayOfWeek(calendarDateOfDateOnlyInstant(night));
      return (
        policy.triggerDays.includes(dow) &&
        dateRangesOverlap(night, night, policy.startDate, policy.endDate)
      );
    });

    if (affected.length > 0 && nightCount < policy.minimumNights) {
      // Find the first triggering day name for the message
      const triggerDayNames = [...new Set(
        policy.triggerDays
          .filter((d) =>
            affected.some(
              (n) => calendarDayOfWeek(calendarDateOfDateOnlyInstant(n)) === d,
            ),
          )
          .map(dayName)
      )];

      const triggerDay = triggerDayNames.join(", ");
      const message = `Bookings including a ${triggerDay} night require a minimum stay of ${policy.minimumNights} nights (${policy.name}). Your booking is ${nightCount} night${nightCount === 1 ? "" : "s"}.`;

      violations.push({
        reasonCode: "MINIMUM_STAY",
        policyId: policy.id,
        policyVersion: policy.version,
        policyName: policy.name,
        resolvedScope: policy.lodgeId
          ? {
              kind: "LODGE",
              lodgeId: policy.lodgeId,
              effectiveLodgeId,
            }
          : {
              kind: "CLUB_WIDE",
              lodgeId: null,
              effectiveLodgeId,
            },
        affectedNights: canonicalAffectedNights(affected),
        requirements: {
          kind: "MINIMUM_STAY",
          minimumNights: policy.minimumNights,
          actualNights: nightCount,
          triggerDays: [...new Set(policy.triggerDays)].sort((a, b) => a - b),
        },
        exceptionEligible: true,
        capacityMode: policy.capacityMode,
        message,
        triggerDay,
        minimumNights: policy.minimumNights,
        actualNights: nightCount,
      });
    }
  }

  return aggregatePolicyExceptionViolations(violations).violations as MinimumStayViolation[];
}

export function validateMinimumStayWithPolicies(
  checkIn: Date,
  checkOut: Date,
  policies: MinimumStayPolicyLike[],
  effectiveLodgeId: string,
): { valid: boolean; violations: MinimumStayViolation[] } {
  const violations = getMinimumStayViolations(
    checkIn,
    checkOut,
    policies,
    effectiveLodgeId,
  );
  return { valid: violations.length === 0, violations };
}

// test seam
/**
 * Format a violation into a user-friendly error message.
 */
export function formatViolationMessage(violation: MinimumStayViolation): string {
  return violation.message;
}

/**
 * Format all violations into a single details string for API responses.
 *
 * NAMES THE RULE. The output carries the policy's name, its required night
 * count and the weekdays that trigger it, so it belongs to an authenticated
 * member-facing response or a server log — never to an unauthenticated body.
 * The public group-join surfaces answer with the generic sentence below instead.
 */
export function formatViolationsDetail(violations: MinimumStayViolation[]): string {
  return violations.map(formatViolationMessage).join(" ");
}

/**
 * The one sentence BOTH public non-member group-join stages answer with when
 * the minimum-stay policy refuses a group's dates (#2363).
 *
 * Deliberately generic, and deliberately declared right beside the detailed
 * formatter above so the choice between them is visible at the point of use.
 * Staging and verification are unauthenticated surfaces reachable by anyone
 * holding a join code or an emailed token; the detailed sentence would turn
 * either into a policy-configuration read the club never agreed to publish
 * there (the public `{{booking-policies}}` token is the surface that decides
 * what of that is public, and it is separately gated). The reader cannot act on
 * the detail either — a non-member cannot move a group's dates, only the
 * organiser can — so the sentence names the fix instead.
 *
 * The detailed sentence and the frozen review snapshot still reach the club, in
 * a server log line each stage writes beside its refusal — and ONLY there. Both
 * stages hand their caller this sentence plus a code/outcome and nothing else:
 * the staged refusal is a thrown error caught next to an unauthenticated
 * response body, and the verification refusal is a returned object the route
 * spreads fields out of, so a detail carried on either is one careless spread
 * from publication rather than merely unread.
 *
 * Shared by both stages so they cannot drift, which is exactly how verification
 * came to answer with the detailed sentence while staging answered with this.
 */
export const PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE =
  "This group's stay is shorter than the minimum stay required for those " +
  "nights, so it cannot accept sign-ups. Please contact the organiser.";
