import { NextResponse } from "next/server";

import { PolicyExceptionMemberMessageError } from "@/lib/booking-exception-requests";
import {
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
} from "@/lib/booking-guests";
import { BookingGuestStayRangeValidationError } from "@/lib/booking-guest-stay-range-input";
import {
  LostSupersedeClaimError,
  NoEligiblePolicyExceptionError,
  OpenExceptionRequestConflictError,
  PolicyExceptionCapacityUnavailableError,
  PolicyExceptionDependantIdentityError,
} from "@/lib/booking-exception-request-service";

/**
 * Map a request-creation domain error to its HTTP response. Shared by every
 * policy-exception request route so new-booking and modification surfaces answer
 * the same failure the same way. A non-domain error is rethrown for the route's
 * own catch/500 handling.
 */
export function mapExceptionRequestError(error: unknown): NextResponse {
  if (error instanceof PolicyExceptionMemberMessageError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof NoEligiblePolicyExceptionError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  // #2562: machine-readable, because the member-facing form has a DIFFERENT next
  // step for each of these two and cannot tell them apart from prose. An
  // already-open request means "go and replace the one you have"; a lost
  // supersede claim means "the one you were replacing has already been decided,
  // so reload and look at it".
  if (error instanceof OpenExceptionRequestConflictError) {
    return NextResponse.json(
      { error: error.message, code: "OPEN_EXCEPTION_REQUEST" },
      { status: 409 },
    );
  }
  if (error instanceof LostSupersedeClaimError) {
    return NextResponse.json(
      { error: error.message, code: "LOST_SUPERSEDE_CLAIM" },
      { status: 409 },
    );
  }
  // The lodge cannot currently hold the requested change (#2525 FIX 4): a
  // capacity conflict, mapped like the other request-creation conflicts.
  if (error instanceof PolicyExceptionCapacityUnavailableError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  // #2721: the proposed party names one of the requester's OWN recorded
  // dependants as a free-text guest and has not said which person is meant. The
  // create route's own code and sentence, so the wizard's single handler covers
  // both create doors. The collisions are deliberately not echoed here either —
  // see `DependantIdentityRefusal.collisions`.
  if (error instanceof PolicyExceptionDependantIdentityError) {
    return NextResponse.json(
      { error: error.refusal.error, code: error.refusal.code },
      { status: error.refusal.status },
    );
  }
  // #2526: a member id the requester may not book, or a member whose profile is
  // not complete enough. Refused HERE rather than freezing a party the approval
  // could never execute — and refused with the SAME body the member's own
  // booking path returns, including D-8's neutral collapse, so a request route
  // is not a channel for facts the booking route withholds.
  if (error instanceof BookingGuestValidationError) {
    return NextResponse.json(getBookingGuestValidationErrorResponse(error), {
      status: error.status,
    });
  }
  // #2526: the proposed stay ranges are not a shape the canonical planner would
  // accept (a Date In with no Date Out, an empty night set). Refused at
  // submission rather than frozen as a proposal that cannot be applied.
  if (error instanceof BookingGuestStayRangeValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  throw error;
}
