import { NextResponse } from "next/server";

/**
 * The ONE sentence every deleted-booking refusal says (#2700).
 *
 * The rule this module IS: `INV-ADDPAY-034`. Read that for the full statement,
 * including which five surfaces may use this constant and why a sixth needs a
 * decision rather than an import.
 *
 * WHY A MESSAGE AND NOT A BARE 404. `INV-ADDPAY-031` — the house shape for a
 * deleted-booking guard, set by `requested-room/options` (#2673) and
 * `refund-request` POST (#2674) — says the 404 body must be byte-identical to
 * the ordinary not-found body, so an authorised caller cannot tell a deleted
 * booking from one that never existed. The owner's 10 Aug 2026 walkthrough of
 * #2700 deliberately departs from that half of the rule on the surfaces below,
 * and the departure is worth stating precisely because the general rule is the
 * opposite of it.
 *
 * Handing an entitled reader "Booking not found" is a dead end that reads as a
 * fault. Telling them the booking was cancelled or removed is an explanation
 * they can act on.
 *
 * WHERE IT IS SAID — five surfaces, by owner decision 20 Nov 2026 (#5266),
 * which settled what #2700 left open. Three answer an API call: the
 * change-requests GET, the refund-request GET and the consent write. Two are
 * pages a person reaches from an old club email, through
 * `components/removed-booking-notice.tsx`: the booking page, for its owner or a
 * member guest on it, and the delegate consent page, for the consent target or
 * their accepted family adult. Everybody else on those pages — another member,
 * a Booking Officer or read-only admin not on the booking, a stranger with a
 * forwarded link — still gets the page's plain "not found", by the same reads
 * as for an id that never existed. A signed-out visitor is sent to sign in
 * before any of this runs. `INV-ADDPAY-034` holds the full list.
 *
 * THAT IS SAFE ONLY BECAUSE OF WHERE THE GUARD SITS. Every caller of this
 * module places the check AFTER its authorisation check, so to see this
 * sentence at all you must already be the guest on that booking, its owner, a
 * consent target's accepted delegate, or (on the APIs) an admin. A stranger
 * still gets 403 or "not found" and learns nothing, which is the property
 * `INV-ADDPAY-031`'s ordering half exists to protect and which is untouched
 * here. Disclosure to somebody already entitled to the record is not an oracle.
 *
 * WHAT THE SENTENCE DELIBERATELY DOES NOT SAY:
 * - **Who deleted it.** The guest does not need it, the system cannot always
 *   assert it accurately, and naming an actor invites the reader to wonder
 *   whether somebody made a mistake.
 * - **The booking owner's name.** That would leak a member's name on a booking
 *   the club has deleted. "Contact the club" costs the reader nothing.
 *
 * ONE MESSAGE, NOT FIVE. Every surface shares this constant precisely so the
 * wording cannot drift into variants that say subtly different things about
 * the same event.
 */
export const DELETED_BOOKING_MESSAGE =
  "This booking has been cancelled or removed. Contact the club if you need to know more.";

/**
 * The shared refusal, as an HTTP response.
 *
 * 404, not 410: 404 is the status `INV-ADDPAY-031` already fixed for a deleted
 * booking across this route folder, every existing client treats it as
 * "gone", and the decision above changes the BODY, not the status. Uniform for
 * every role, including a Full Admin — the record-viewing exemption on
 * `bookings/[id]/page.tsx` belongs to the page, not to the APIs beneath it.
 */
export function deletedBookingRefusalResponse(): NextResponse {
  return NextResponse.json({ error: DELETED_BOOKING_MESSAGE }, { status: 404 });
}
