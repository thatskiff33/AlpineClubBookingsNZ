/**
 * The member-facing refusal an ENFORCED adult-member hosting decision raises.
 *
 * Split verbatim out of `adult-member-hosting-review.ts` (#3128), which was
 * 3,051 lines. Nothing here reads the database or evaluates the rule: it turns
 * an already-decided violation into the error a route throws and the body a
 * member is shown. The engine imports this module; this module imports nothing
 * back from it.
 */
import { ApiError } from "@/lib/api-error";
import {
  aggregatePolicyExceptionViolations,
  type AdultMemberHostingPolicyExceptionViolation,
  type AggregatedPolicyExceptions,
} from "@/lib/booking-policy-exceptions";

/**
 * The refusal the ENFORCED consequence raises (#2569 §1).
 *
 * DELIBERATELY THE SAME SHAPE AS `PaidUpAdultMemberRequiredError` (#2543/#2560),
 * down to the status code and the reasoning behind it: 409, not 403. A 403 says
 * "you may not do this"; this booking IS permitted, by a Booking Officer, through
 * the #2365 exception-request workflow — the state of the party is what conflicts.
 * It also keeps `ADULT_MEMBER_HOSTING_REQUIRED` out of the
 * `HARD_STOP_BOOKING_FAILURE_CODES` family, which is exactly the set of refusals
 * that may NOT enter exception review.
 *
 * NOT A SECOND REFUSAL PATH. The violation it carries is the same frozen
 * `AdultMemberHostingPolicyExceptionViolation` the review mode records, produced
 * by the same evaluator, aggregated by the same `aggregatePolicyExceptionViolations`
 * and re-derived server-side by `collectProposalPolicyViolations` when the member
 * walks through the exception door. Nothing about the officer queue, the frozen
 * snapshot or the override machinery is forked for the enforced mode — only
 * whether the booking is allowed to exist while it waits.
 *
 * WHY IT IS AN ApiError. It is thrown from inside the mutation transactions that
 * every booking write path already runs, so the throw rolls the non-compliant
 * write back — which is what "do not confirm a non-compliant booking" means in
 * practice — and every route that already handles `ApiError` answers 409 with the
 * message rather than a 500. Routes that want to hand the member the exception
 * door as well add a typed branch and return `buildAdultMemberHostingRefusalBody`.
 */
export class AdultMemberHostingRequiredError extends ApiError {
  readonly code = "ADULT_MEMBER_HOSTING_REQUIRED";
  readonly violation: AdultMemberHostingPolicyExceptionViolation;
  readonly exceptionReview: AggregatedPolicyExceptions;

  constructor(violation: AdultMemberHostingPolicyExceptionViolation) {
    super(violation.message, 409);
    this.name = "AdultMemberHostingRequiredError";
    this.violation = violation;
    this.exceptionReview = aggregatePolicyExceptionViolations([violation]);
  }
}

/**
 * Strip the identities of the adult members whose stays cover each night.
 *
 * REQUIRED, NOT DEFENSIVE (#2576 §11). A member-facing body has no business
 * carrying member ids under any scope: `memberIds` is an internal identity the
 * frozen snapshot keeps in full for validation and audit, and the member-facing
 * answer says only that adult-member cover is or is not present. Under
 * `SAME_BOOKING_OWNER` the covering stay is on the member's OWN account, so the
 * privacy stake is lower than the removed lodge-wide scope's was — but the rule is
 * applied to EVERY scope rather than only where it bites, because a redaction that
 * fires under one setting is a redaction nobody tests.
 *
 * The night list and the per-night scope list are kept: "this night is covered,
 * by an adult member on this booking" is the advice §17 asks for, and neither
 * field names a person.
 */
function withheldHostIdentities(
  violation: AdultMemberHostingPolicyExceptionViolation,
): AdultMemberHostingPolicyExceptionViolation {
  return {
    ...violation,
    requirements: {
      ...violation.requirements,
      qualifyingHostsByNight: violation.requirements.qualifyingHostsByNight.map(
        (night) => ({
          night: night.night,
          memberIds: [],
          ...(night.coveredByScopes
            ? { coveredByScopes: night.coveredByScopes }
            : {}),
        }),
      ),
    },
  };
}

/**
 * The member-facing body for an ENFORCED hosting refusal.
 *
 * Mirrors `buildPaidUpAdultRefusalBody` (#2543) so the two refusals a party can
 * trip at once are described the same way, and so a client can rely on
 * `exceptionReview.capacityMode` to know whether asking for an override keeps the
 * beds. Host identities are withheld — see `withheldHostIdentities`.
 *
 * `exceptionRequestPath` states where the member goes next rather than leaving the
 * client to know: "you were refused but you may ask" is useless advice if the
 * caller cannot find the door. For a NEW booking that door reserves nothing — the
 * request holds no beds and capacity is checked again at approval (#2569 §1) —
 * which is what `exceptionReview.capacityMode` reports honestly.
 */
export function buildAdultMemberHostingRefusalBody(
  violation: AdultMemberHostingPolicyExceptionViolation,
) {
  const redacted = withheldHostIdentities(violation);
  const exceptionReview = aggregatePolicyExceptionViolations([redacted]);
  return {
    error: redacted.message,
    code: "ADULT_MEMBER_HOSTING_REQUIRED" as const,
    details: redacted.message,
    violations: exceptionReview.violations,
    exceptionReview,
    exceptionRequestPath: "/api/bookings/exception-requests",
  };
}
