/**
 * The waitlist-confirm route's honest end-state contract (#2623 T4/T8).
 *
 * Phase one of a waitlist confirm (`confirmWaitlistOffer`) commits in its own
 * transaction: it nulls `waitlistOfferedAt` / `waitlistOfferExpiresAt` /
 * `waitlistPosition` and moves the booking out of `WAITLIST_OFFERED`. From that
 * commit onwards **the offer no longer exists**, so every later refusal on the
 * request is a refusal against a booking that can never be confirmed again —
 * confirming a second time reads `Booking is not in WAITLIST_OFFERED status`.
 *
 * Before #2623 those refusals answered with retry-shaped copy and no machine
 * flag, and `WaitlistOfferCard` left an enabled "Confirm Booking" mounted, so
 * the member was invited to click an offer that had already been consumed. The
 * flags below are the server saying which of the three end states the booking
 * actually reached, and the card suppresses the CTA on any of them.
 *
 * Consumers must key on `offerRevoked` — not on the error code — because two
 * different sources share `HOSTING_COVERAGE_PARTICIPANT_RETRY`: a *phase-one*
 * participant refusal rolls back with the offer intact (the CTA is correctly
 * still live), while a *phase-two* refusal has already consumed it.
 */

/** The zero-dollar claim lost capacity; the offer was released back to the queue. */
export const WAITLIST_OFFER_RELEASED_CAPACITY_CODE =
  "WAITLIST_OFFER_RELEASED_CAPACITY" as const;

export const WAITLIST_OFFER_RELEASED_CAPACITY_MESSAGE =
  "A bed was no longer available when we finalised this booking, so the offer was released and your place on the waitlist was restored. You will be offered the next spot that opens — reload the booking to see its current state.";

export const WAITLIST_OFFER_RELEASED_CAPACITY_BODY = Object.freeze({
  code: WAITLIST_OFFER_RELEASED_CAPACITY_CODE,
  error: WAITLIST_OFFER_RELEASED_CAPACITY_MESSAGE,
  offerRevoked: true as const,
  waitlistPlaceRestored: true as const,
});

/**
 * Another writer owned the booking by the time the claim ran under the locks.
 * The offer is gone (phase one consumed it) and where the booking landed is not
 * this request's to report, so the member is sent to canonical state.
 */
export const WAITLIST_CONFIRM_STATUS_MOVED_CODE =
  "WAITLIST_CONFIRM_STATUS_MOVED" as const;

export const WAITLIST_CONFIRM_STATUS_MOVED_MESSAGE =
  "This booking changed while we were finalising it, so the offer is no longer open. Reload the booking to see its current status before doing anything else.";

/**
 * The offer is gone and the booking is no longer this request's to describe.
 * Deliberately NOT `waitlistPlaceRestored: false`: that flag means "we tried to
 * put your place back and could not", which is the operator case below. Here
 * another writer simply owns the row, and the canonical state is a reload away.
 */
export const WAITLIST_OFFER_CONSUMED_STATUS_MOVED_FLAGS = Object.freeze({
  offerRevoked: true as const,
  bookingStatusUnconfirmed: true as const,
});

export const WAITLIST_CONFIRM_STATUS_MOVED_BODY = Object.freeze({
  code: WAITLIST_CONFIRM_STATUS_MOVED_CODE,
  error: WAITLIST_CONFIRM_STATUS_MOVED_MESSAGE,
  ...WAITLIST_OFFER_CONSUMED_STATUS_MOVED_FLAGS,
});

/**
 * The compensating release lost its own locks. The booking is parked in
 * `PAYMENT_PENDING` with the offer consumed: for a $0 booking that is a state
 * with neither a payment path nor an offer, and no cron clears it — so this is
 * the one waitlist-confirm outcome that needs an operator. Never retry-shaped
 * copy: there is nothing the member can retry.
 */
export const WAITLIST_CONFIRM_AWAITING_OPERATOR_CODE =
  "WAITLIST_CONFIRM_AWAITING_OPERATOR" as const;

export const WAITLIST_CONFIRM_AWAITING_OPERATOR_MESSAGE =
  "We could not finish confirming this booking and could not put your waitlist place back automatically, so it is now waiting on a lodge administrator. Your offer has been used up — do not try to confirm again. Reload the booking to see its current state and contact the lodge administrator, quoting the booking reference, if it has not changed within a day.";

export const WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY = Object.freeze({
  code: WAITLIST_CONFIRM_AWAITING_OPERATOR_CODE,
  error: WAITLIST_CONFIRM_AWAITING_OPERATOR_MESSAGE,
  offerRevoked: true as const,
  waitlistPlaceRestored: false as const,
  awaitingOperatorRecovery: true as const,
});

/**
 * The offer was released back to the waitlist after a phase-two failure whose
 * cause is not the member's to act on. Spread alongside a mapped status; the
 * participant-fence path spreads these flags into the frozen retry body instead
 * so the one public retry sentence stays byte-identical everywhere.
 */
export const WAITLIST_OFFER_RELEASED_FLAGS = Object.freeze({
  offerRevoked: true as const,
  waitlistPlaceRestored: true as const,
});

export const WAITLIST_CONFIRM_RELEASED_UNAVAILABLE_CODE =
  "WAITLIST_CONFIRM_RELEASED_UNAVAILABLE" as const;

export const WAITLIST_CONFIRM_RELEASED_UNAVAILABLE_MESSAGE =
  "We could not finish confirming this booking, so the offer was released and your place on the waitlist was restored. You will be offered the next spot that opens — reload the booking to see its current state.";

export const WAITLIST_CONFIRM_RELEASED_UNAVAILABLE_BODY = Object.freeze({
  code: WAITLIST_CONFIRM_RELEASED_UNAVAILABLE_CODE,
  error: WAITLIST_CONFIRM_RELEASED_UNAVAILABLE_MESSAGE,
  ...WAITLIST_OFFER_RELEASED_FLAGS,
});

/** The audit action an operator filters on to find a stranded confirm. */
export const WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION =
  "waitlist.confirm_offer_release_failed";

/**
 * Positive proof that the offer this card is showing has already been consumed
 * server-side. A second confirm cannot succeed, so every consumer must stop
 * offering one and send the member to canonical state.
 */
export function isWaitlistOfferRevoked(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).offerRevoked === true;
}

/** The subset of the above that a member cannot resolve without an operator. */
export function isWaitlistConfirmAwaitingOperator(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.offerRevoked === true &&
    candidate.awaitingOperatorRecovery === true
  );
}

/**
 * The AI app action `accept_waitlist_offer` (ALP-794) is refused a cross-lodge
 * offer: accepting one cancels the waitlist place and books another lodge at a
 * price the app's answer does not show, and ADR-004 has the member re-confirm
 * at the figure they can see, on the website. Nothing is written, so the offer
 * stands; the route answers 409.
 */
export const WAITLIST_CROSS_LODGE_WEBSITE_ONLY_CODE =
  "CROSS_LODGE_OFFER_WEBSITE_ONLY" as const;
