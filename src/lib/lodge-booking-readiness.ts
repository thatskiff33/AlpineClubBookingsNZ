/**
 * Whether a lodge can take a booking at all, and what a person is told when it
 * cannot (#3407, `INV-CAP-003`).
 *
 * The owner's decision of 14 Sep 2026: at a lodge nobody has given a capacity
 * (`unconfigured_lodge`), the refusal "says the lodge is not set up for
 * bookings yet rather than quoting a limit of zero", and the calendar says the
 * same instead of Waitlist or Full. Neither changes a booking rule: the
 * party-size check still refuses, it only stops explaining itself as "cannot
 * exceed 0 guests".
 *
 * Import-free on purpose, like `lodge-effective-capacity.ts`: the member
 * calendar is a client component and reads it directly, and so do a dozen
 * server doors whose tests mock `lodge-capacity.ts` wholesale.
 */

export const LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE =
  "This lodge is not set up for bookings yet: the club has not set how many guests it can take.";

/**
 * The same refusal for a check that has no lodge of its own and measures the
 * club's DEFAULT lodge instead — the group-discount policy's minimum size. An
 * officer editing a club-wide policy is not at "this lodge".
 */
export const DEFAULT_LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE =
  "The club's default lodge is not set up for bookings yet: the club has not set how many guests it can take, so nothing can be checked against its capacity.";

/**
 * Whether a lodge's RESOLVED capacity can take any booking at all.
 *
 * Keyed on the resolved figure rather than on the `source`, and the two are the
 * same question: every bookable source resolves to at least one guest, because
 * a configured capacity is saved only within the bounds in
 * `lodge-effective-capacity.ts` (minimum `MIN_CONFIGURED_LODGE_CAPACITY`, which
 * is 1) and a bed-derived figure needs at least one active bed. So a resolved 0
 * IS `unconfigured_lodge`; `lodge-booking-readiness.test.ts` pins that
 * equivalence over every source. That is true of the resolver's LABEL, not
 * always of the world: the resolver fails closed, turning an unreadable
 * settings row into no capacity, so a database fault reads as "not set up"
 * here too. The booking is refused either way; only the stated cause is
 * imprecise, and the resolver carries no error signal to tell the two apart. Reading the number keeps this answerable by
 * every door that already holds it — including the member calendar, which is
 * sent the number and nothing else.
 */
export function isLodgeSetUpForBookings(resolvedCapacity: number): boolean {
  return resolvedCapacity > 0;
}

/**
 * The party-size refusal for one door. A lodge that is set up keeps that door's
 * own wording, byte for byte; one that is not gets
 * `LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE`, so no refusal anywhere quotes a
 * limit of zero.
 */
export function lodgeGuestLimitMessage(
  resolvedCapacity: number,
  configuredMessage: (limit: number) => string,
  notSetUpMessage: string = LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE,
): string {
  return isLodgeSetUpForBookings(resolvedCapacity)
    ? configuredMessage(resolvedCapacity)
    : notSetUpMessage;
}
