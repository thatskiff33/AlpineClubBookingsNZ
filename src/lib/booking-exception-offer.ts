/**
 * "May this refusal offer to ask a Booking Officer?" — the ONE rule (#2562).
 *
 * Both member-facing wizards (the new-booking wizard and the edit-booking panel)
 * decide whether to draw the "Request Booking Officer approval" action by calling
 * this function on the refusal body the server just sent them. It lives in a
 * shared, dependency-free module for one reason: the owner's decision is that the
 * action appears ONLY where the server confirms every blocking failure is
 * exception-eligible, and two surfaces each re-deriving that rule is exactly how
 * one of them ends up offering a door the server would slam.
 *
 * Nothing here re-decides policy. It reads what the server already computed and
 * refuses to interpret anything it does not recognise.
 *
 * FAILS CLOSED, four times over:
 *
 *  1. The refusal's `code` must be on the explicit allowlist below. A refusal
 *     with no code, an unknown code, or any hard-stop code offers nothing — so
 *     insufficient capacity, invalid or past dates, missing consent, no authority
 *     over a guest, a member-night clash, a payment or membership block and a
 *     data-integrity failure can never reach the request form, whatever else the
 *     body contains.
 *  2. `exceptionReview.violations` must be present and non-empty. The server
 *     attaches that block only to a refusal it has itself classified as
 *     reviewable; its absence means "not reviewable", never "probably fine".
 *  3. EVERY violation must be individually eligible — an allowlisted reason code
 *     AND the server's own `exceptionEligible: true` flag AND a known capacity
 *     mode. One unrecognised violation in the list disqualifies the whole refusal,
 *     because a request can only override the rules it froze, and a member offered
 *     a request that cannot clear their actual blockage is being sent on an
 *     errand.
 *  4. The result carries the violations VERBATIM. The caller renders the server's
 *     own frozen sentences; it never composes its own account of which rule is
 *     tripping.
 */
import {
  isHardStopBookingFailureCode,
  isPolicyExceptionReasonCode,
  POLICY_EXCEPTION_CAPACITY_MODES,
  type PolicyExceptionCapacityMode,
  type PolicyExceptionReasonCode,
} from "@/lib/booking-policy-exceptions";

/**
 * The refusal codes that may offer the request action.
 *
 * Deliberately SHORT and deliberately NOT "every code that ships an
 * exceptionReview":
 *
 *  - `MINIMUM_STAY_VIOLATION` — the create path's hard block and the two save
 *    paths' (`/modify`, `/modify-dates`) block. A member cannot book those nights
 *    at all without a Booking Officer, which is precisely what the workflow is
 *    for.
 *  - `PAID_UP_ADULT_MEMBER_REQUIRED` — #2543's 409 under NON_MEMBER_PRICING, on
 *    both the create and the modify paths. Deliberately a 409 rather than a 403
 *    because the booking IS permitted, by an officer, through this workflow.
 *
 * `ADULT_MEMBER_HOSTING_CONFIRM_REQUIRED` is deliberately ABSENT even though it
 * carries an `exceptionReview`. That 409 is raised only for an ADMIN booking on
 * somebody's behalf, and it asks the admin for a reason to record — the person
 * being refused is the person who would approve the request, so offering them a
 * request form would be a loop, not a remedy. A member self-booking never receives
 * it: the hosting rule opens an admin review AFTER the booking is made rather than
 * refusing it (epic decisions D-R3/D-R4). The rule can still reach an exception
 * request through the OTHER two codes, because a refusal's frozen evidence carries
 * every covered violation, hosting included.
 */
export const EXCEPTION_ELIGIBLE_REFUSAL_CODES = [
  "MINIMUM_STAY_VIOLATION",
  "PAID_UP_ADULT_MEMBER_REQUIRED",
] as const;

export type ExceptionEligibleRefusalCode =
  (typeof EXCEPTION_ELIGIBLE_REFUSAL_CODES)[number];

const EXCEPTION_ELIGIBLE_REFUSAL_CODE_SET = new Set<string>(
  EXCEPTION_ELIGIBLE_REFUSAL_CODES,
);

const CAPACITY_MODE_SET = new Set<string>(POLICY_EXCEPTION_CAPACITY_MODES);

/** One violation as the caller may render it — the server's frozen sentence. */
export interface ExceptionOfferViolation {
  reasonCode: PolicyExceptionReasonCode;
  /** The policy's own plain-language rendering, shown verbatim. */
  message: string;
  /** Sorted NZ lodge nights (YYYY-MM-DD) the rule bites on. */
  affectedNights: string[];
  capacityMode: PolicyExceptionCapacityMode;
}

/**
 * Everything a surface needs to draw the action, or `null` for "do not draw it".
 * Null is the answer for every hard failure and for every refusal this module
 * does not fully understand.
 */
export interface ExceptionOffer {
  /** Which refusal opened the door — carried so the UI can name the blockage. */
  code: ExceptionEligibleRefusalCode;
  /** The server's refusal sentence, shown verbatim. */
  message: string;
  /** Every covered violation, so all of them are explained at once. */
  violations: ExceptionOfferViolation[];
  /** HOLD if any covered rule holds beds — the server's own aggregate. */
  capacityMode: PolicyExceptionCapacityMode;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read one violation, or `null` if it is not fully, recognisably eligible.
 *
 * `exceptionEligible: true` is the server's own assertion and is REQUIRED, not
 * inferred from the reason code: the frozen violation shapes carry the flag as a
 * literal `true`, so a body that omits it is either not a frozen violation or came
 * from a path that never classified it, and neither may open the door.
 */
function readViolation(value: unknown): ExceptionOfferViolation | null {
  const violation = asRecord(value);
  if (!violation) return null;
  const reasonCode = violation.reasonCode;
  if (typeof reasonCode !== "string" || !isPolicyExceptionReasonCode(reasonCode)) {
    return null;
  }
  if (violation.exceptionEligible !== true) return null;
  const capacityMode = violation.capacityMode;
  if (typeof capacityMode !== "string" || !CAPACITY_MODE_SET.has(capacityMode)) {
    return null;
  }
  return {
    reasonCode,
    message: typeof violation.message === "string" ? violation.message : "",
    affectedNights: Array.isArray(violation.affectedNights)
      ? violation.affectedNights.filter((n): n is string => typeof n === "string")
      : [],
    capacityMode: capacityMode as PolicyExceptionCapacityMode,
  };
}

/**
 * Decide whether a refusal body may offer the "Request Booking Officer approval"
 * action, and with what to show.
 *
 * Returns `null` — do not offer — for anything at all that does not pass every
 * gate: a body that is not an object, a missing or hard-stop code, an absent or
 * empty `exceptionReview`, any violation that is not recognisably eligible, or an
 * aggregate capacity mode the client does not know.
 */
export function readExceptionOffer(body: unknown): ExceptionOffer | null {
  const data = asRecord(body);
  if (!data) return null;

  const code = data.code;
  if (typeof code !== "string") return null;
  // Belt and braces: a hard-stop failure code can never be allowlisted, and
  // saying so here means a future edit to the allowlist cannot quietly admit one.
  if (isHardStopBookingFailureCode(code)) return null;
  if (!EXCEPTION_ELIGIBLE_REFUSAL_CODE_SET.has(code)) return null;

  const review = asRecord(data.exceptionReview);
  if (!review) return null;
  const rawViolations = review.violations;
  if (!Array.isArray(rawViolations) || rawViolations.length === 0) return null;

  const violations: ExceptionOfferViolation[] = [];
  for (const raw of rawViolations) {
    const violation = readViolation(raw);
    // ONE unrecognised violation disqualifies the whole refusal. A partial
    // override is not a thing the workflow can do.
    if (!violation) return null;
    violations.push(violation);
  }

  const aggregate = review.capacityMode;
  if (typeof aggregate !== "string" || !CAPACITY_MODE_SET.has(aggregate)) {
    return null;
  }

  return {
    code: code as ExceptionEligibleRefusalCode,
    message:
      typeof data.error === "string" && data.error
        ? data.error
        : violations[0].message,
    violations,
    capacityMode: aggregate as PolicyExceptionCapacityMode,
  };
}

// ---------------------------------------------------------------------------
// What a NEW-BOOKING exception request cannot carry (#2562)
// ---------------------------------------------------------------------------

/**
 * The wizard choices that a new-booking exception request DOES NOT carry.
 *
 * WHY THIS EXISTS. `POST /api/bookings/exception-requests` accepts exactly five
 * things — lodge, check-in, check-out, guests, the member's message (plus the
 * supersede id) — because a policy-exception proposal IS a party and a set of
 * nights: that is what gets hashed, frozen and re-executed byte-for-byte. The
 * wizard's own create call sends a great deal more, and
 * `executeApprovedNewBooking` calls `createConfirmedBooking` with none of it: no
 * promo, no credit election, no room request, no notes, no payment-method
 * choice. So an approval prices and books at the club's normal rates. (An
 * expected arrival time was a fifth item here until #2621 retired the entry
 * altogether; it is not a wizard choice any more, so there is nothing left to
 * drop.)
 *
 * The card used to be told there was nothing to disclose here ("a new booking's
 * whole intent IS the party and the nights"), which is true of the PROPOSAL and
 * false of the member's screen: a working-bee attendee whose free night is
 * expressed as a promo was shown the discounted figure with no notice, and the
 * approved booking billed the full rate.
 *
 * Every field is REQUIRED and explicitly typed, for the same reason the edit
 * panel's counterpart derives its list from real payload keys: a wizard choice
 * added later cannot be silently dropped without somebody deciding, in writing,
 * whether the request carries it.
 */
export interface NewBookingExceptionExtras {
  /** A manually entered promo code, when one is applied. */
  promoCode: string | null;
  /** A selected working-bee event, when the member ticked one. */
  workPartyEventId: string | null;
  /** Whether the member's applied discount came from a work party. */
  workPartyDiscountApplied: boolean;
  /** Account credit the member elected to spend, in integer cents. */
  appliedCreditCents: number;
  /** A requested room, when the club offers room requests. */
  requestedRoomId: string | null;
  /** Free-text notes for the club. */
  notes: string | null;
  /** True when the member chose internet banking over card. */
  internetBankingChosen: boolean;
  /** The "only book if my guests can come" election. */
  cancelIfGuestsBumped: boolean;
  /** True when the member asked to open this as a group trip. */
  groupTrip: boolean;
}

/**
 * Those of the wizard's extras that change what the club would CHARGE.
 *
 * Kept as its own predicate because the price on the card is only honest when
 * none of these is set: the figure has to be the undiscounted quote for the party
 * and nights being frozen, and the label has to say so when a discount the member
 * can see on the screen above is not part of what they are sending.
 */
export function newBookingExceptionOmitsPricedChoice(
  extras: NewBookingExceptionExtras,
): boolean {
  return (
    extras.promoCode !== null ||
    extras.workPartyDiscountApplied ||
    extras.workPartyEventId !== null ||
    extras.appliedCreditCents > 0
  );
}

/** The dropped choices, named for the member, in a stable order. */
export function newBookingExceptionOmittedChanges(
  extras: NewBookingExceptionExtras,
): string[] {
  const omitted: string[] = [];
  if (extras.promoCode !== null) omitted.push("the promo code");
  if (extras.workPartyEventId !== null || extras.workPartyDiscountApplied) {
    omitted.push("the working bee discount");
  }
  if (extras.appliedCreditCents > 0) omitted.push("using account credit");
  if (extras.requestedRoomId !== null) omitted.push("the room you asked for");
  if (extras.notes !== null) omitted.push("your note to the club");
  if (extras.internetBankingChosen) {
    omitted.push("paying by internet banking");
  }
  if (extras.cancelIfGuestsBumped) {
    omitted.push('the "only book if my guests can come" choice');
  }
  if (extras.groupTrip) omitted.push("opening this as a group trip");
  return omitted;
}
