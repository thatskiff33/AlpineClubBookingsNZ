import type { Prisma, Role } from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import { STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL } from "@/lib/stored-night-price-repair";

/**
 * The reciprocal "other club member" rate on a booking (Other Lodges epic,
 * follow-up to #2749).
 *
 * A booking officer names a partner lodge on the booking (`Booking.otherLodgeId`)
 * and then ticks the individual guests who belong to it
 * (`BookingGuest.otherLodgeMember`). Those guests price from the club's own FULL
 * member rate rows at their own age tier; everybody else is untouched.
 *
 * WHICH GUESTS MAY BE TICKED (#2978). Anyone currently priced at the club's
 * NON-MEMBER rate - not merely anyone with `isMember` false. The two are not the
 * same set: a non-member contact minted by book-on-behalf and re-added through
 * the member-guest finder carries `isMember` true while resolving to the
 * built-in NON_MEMBER type, and those people are precisely who a reciprocal rate
 * is for. `resolveOtherLodgeRateEligibleGuestIds` is the single answer, used by
 * the edit panel to decide which rows get a tick box and by this resolver to
 * refuse a tick on anybody else.
 *
 * WHY THIS MODULE EXISTS RATHER THAN THE RULE BEING WRITTEN TWICE. The preview
 * (`modify-quote`) and the save (`modifyBookingBatch` → `prepareGuestPlan`) must
 * agree exactly: the panel shows a per-person fee and a settlement delta from the
 * first, and charges them through the second, so any divergence is a quote/charge
 * mismatch of the whole member/non-member spread. Both call
 * {@link resolveOtherLodgeRateElection} with the same stored booking and the same
 * request fields, and both read the effective flag and the "must reprice" set off
 * the result. That is the same shape the #2337 placeholder→member link uses, and
 * for the same reason.
 *
 * IT CHANGES THE RATE AND NOTHING ELSE. `BookingGuest.isMember` is never
 * written by this feature, so adult-member hosting, the non-member hold, split
 * bookings, `Booking.hasNonMembers`, the subscription gate and member-only
 * promotions all keep seeing exactly what they saw before the tick — which is
 * the truth: the tick records that somebody is a member of ANOTHER club, and
 * says nothing about their standing in this one.
 */

export const OTHER_LODGE_RATE_ADMIN_ONLY_MESSAGE =
  "Only an admin or booking officer can price a guest at the other-lodge member rate.";
export const OTHER_LODGE_RATE_GUEST_NOT_ON_BOOKING_MESSAGE =
  "One or more other-lodge member ticks referenced a guest not on this booking.";
/**
 * #2978: the refusal is now about the RATE, not about `isMember`. Two different
 * people trip it and the sentence has to serve both - somebody already on this
 * club's member rate (there is nothing to re-rate), and a member who owes this
 * club a subscription (re-rating them would hand back the member rate the
 * lockout exists to withhold). Naming the subscription case explicitly is
 * deliberate: an officer who ticks a lapsed member and gets a bare "not
 * eligible" would reasonably conclude the feature is broken.
 *
 * IT NAMES THE GUEST, because a six-guest booking refused with "that guest"
 * leaves the officer ticking boxes one at a time to find out who. The two
 * reasons stay behind one "or": which of them applies is the difference between
 * "they are a member" and "their subscription is unpaid", and the second is not
 * this screen's to disclose. That is a soft consideration rather than a control
 * — the refusal is only reachable after the `role !== "ADMIN"` 403, so the only
 * person who can read it is a booking officer, who could look the member up
 * anyway.
 */
export function otherLodgeRateIneligibleGuestMessage(
  guestName?: string | null,
): string {
  const who = guestName?.trim() || "That guest";
  return `${who} cannot be priced at the other-lodge member rate: they are already on this club's member rate, or they are a member who owes this club a subscription.`;
}

/** The un-named form, for a caller that holds no name for the guest. */
export const OTHER_LODGE_RATE_INELIGIBLE_GUEST_MESSAGE =
  otherLodgeRateIneligibleGuestMessage();
export const OTHER_LODGE_RATE_LODGE_REQUIRED_MESSAGE =
  "Choose the other lodge before marking anybody as one of its members.";
export const OTHER_LODGE_RATE_LODGE_NOT_FOUND_MESSAGE = "Selected lodge not found";
/**
 * The other-club re-rate is refused on a mid-stay (in-progress) edit, for
 * exactly the reason the #2337 link is (`GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE`).
 *
 * A mid-stay edit prices through `buildInProgressGuestRangePlan`, which is fed
 * the ORIGINAL stored guest rows rather than the election-modified pricing rows.
 * The cleared `lockedNightPrices` and the new flag therefore never reach
 * pricing: the re-rate would stamp the guest and settle $0. Refusing is the
 * honest answer, and it is refused on BOTH the preview and the save so the
 * officer sees the refusal rather than a phantom $0 quote.
 */
export const OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE =
  "The other-lodge member rate cannot be changed once a booking has started. Contact the office to adjust the price on a stay that is already under way.";

/**
 * The other-club re-rate is ALSO refused on the edit that parks a booking's
 * money for review (#3214, epic #2797; owner decision 2 September 2026).
 *
 * ## The one edge that behaved differently from the rest of the system
 *
 * An edit whose existing guest strands cannot be priced from this booking's own
 * stored sold-price history commits its structural half and parks the amount as
 * an OPEN financial review (`INV-MOD-028`). Once that review is open, EVERY
 * later election is already refused outright: an election is never
 * price-preserving, so the request is money-affecting, so
 * `assertNoPendingEditFinancialReview` throws.
 *
 * The edit that CREATES the park was the single exception, and it half-applied
 * the request in both directions:
 *
 *  - a tick resolved to `false`, because a parked edit runs no rate resolver and
 *    so rates nobody at the other-lodge rate — while the same edit still saved a
 *    change of lodge, so the officer got a success, a partner lodge on the
 *    booking, and no ticks;
 *  - an untick cleared the flag unconditionally (it must, or a stale flag could
 *    never be removed) while the nights stayed sold at the other club's member
 *    rate — leaving the column and the money saying different things about what
 *    was charged.
 *
 * Refusing removes no ability anybody has: it is refused on every booking whose
 * review is already open, and this makes the one inconsistent edge behave the
 * same way. Disclosure was weighed and rejected — it would have left the product
 * refusing in one breath and accepting-then-silently-dropping in the next, and
 * would have described the untick disagreement rather than prevented it.
 *
 * ## What the wording has to carry
 *
 * That the election was refused; that the whole edit was refused with it, ticks
 * AND lodge, because a refusal that saved half of the request is the defect
 * being fixed; why; and what has to be true before the tick can be set. The
 * refusal is raised on the SAVE before anything is written, and mirrored on the
 * PREVIEW so the officer meets it before pressing Save rather than after — the
 * same preview/save parity {@link OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE} keeps.
 *
 * IT NAMES A CONDITION AND WHERE TO MEET IT, NOT A PROCEDURE, and that is
 * deliberate. An earlier draft told the officer to "save the rest of the change
 * on its own" and then "settle the amount the office is asked to confirm". Both
 * are false on the case this refusal is most likely to meet: an ELECTION-ONLY
 * edit has no rest to save, and a refused edit raises no `EDIT_FINANCIAL_REVIEW`
 * task, so there is nothing anybody was asked to confirm. What IS true in every
 * case is the condition — the booking's unpriced nights have to carry a price
 * before anything on it can be re-rated — so the message states that, names the
 * one control that satisfies it, and stops.
 *
 * ## THE SENTENCE USED TO BE UNSATISFIABLE, and #3214 built the route that makes
 * it true
 *
 * This paragraph previously ended by recording a gap rather than closing it: on
 * a QUOTE-PRICED booking those nights provably COULD NOT be given a price,
 * because `QUOTE_PRICED_EDIT_BLOCK_MESSAGE` refuses every other edit that could
 * park, the settle-time repair only runs while completing an OPEN review task,
 * and re-approval refuses a booking that is no longer `AWAITING_REVIEW`. So the
 * refusal named a condition nobody could reach — on exactly the population it
 * most often meets, because the public request form is where the "are you a
 * member of another lodge?" answer arrives and a converted request is
 * quote-priced by origin.
 *
 * That gap is now closed. `Admin tools` on the booking's own page offers the
 * control named by {@link STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL} — the one
 * home for that name, interpolated into the message below rather than typed
 * into it — for every guest strand whose stored rows
 * cannot be read back — blank rows, no rows at all, or rows that do not add up
 * — fenced so the amounts must come to what the stay is ALREADY stored as being
 * worth, which is what lets it run outside any review and change nothing anybody
 * owes (`stored-night-price-strand-reconcile.ts`). Once a strand is recorded the
 * classifier prices it exactly and this refusal stops firing on it. The message
 * therefore names that control: a condition plus the place it is satisfied is
 * still not a procedure, and an officer told only the condition would have to go
 * and find it.
 *
 * A 400 rather than the 409 the already-open case uses, deliberately: that
 * status carries `EDIT_FINANCIAL_REVIEW_PENDING_CODE`, which asserts a review is
 * already open, and here none is. This is a request two of whose parts cannot be
 * combined, which is what every other refusal in this module is.
 */
export const OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE = `The other-lodge member rate cannot be set on this change, because this booking has nights whose original price the club's records cannot tell us. That means an officer has to work the amount out by hand, and this change prices nothing — so a tick here would record a rate nobody was charged. Nothing has been saved: not the ticks, and not the lodge. Those nights have to carry a price before anything on this booking can be re-rated: an officer does that under Admin tools on this booking, with "${STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL}", and the other-lodge rate can be set once it is done.`;

/**
 * The status BOTH whole-request refusals above answer with, in one place.
 *
 * The number was argued at length — in {@link
 * OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE}'s docblock, which explains why
 * this is a 400 and not the 409 the already-open review case uses — and it was
 * then typed out at four call sites: two throws on the save paths and two
 * `NextResponse.json` literals on the preview. The reasoning and the number
 * could not be changed together, which is the defect `INV-SSOT` names. The
 * classes below bind each message to it, the way
 * `EditFinancialReviewPendingError` binds its own message to its 409, so a save
 * `throw`s one and a preview reads `.message`/`.status` off one.
 *
 * Deliberately NOT extended to the resolver's own 400s further down (a tick on a
 * guest who is not on the booking, an ineligible guest, a missing lodge): those
 * refuse one FIELD of an otherwise valid request rather than the request as a
 * whole, they are per-guest and interpolate a name, and none of them has a
 * status argued anywhere. Sweeping them in would be a rename, not a fix.
 */
const OTHER_LODGE_RATE_REFUSAL_STATUS = 400;

/** The mid-stay refusal, message and status bound together. */
export class OtherLodgeRateInProgressError extends ApiError {
  constructor() {
    super(OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE, OTHER_LODGE_RATE_REFUSAL_STATUS);
    this.name = "OtherLodgeRateInProgressError";
  }
}

/** The parking-edit refusal (#3214), message and status bound together. */
export class OtherLodgeRateAmountUnderReviewError extends ApiError {
  constructor() {
    super(
      OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE,
      OTHER_LODGE_RATE_REFUSAL_STATUS,
    );
    this.name = "OtherLodgeRateAmountUnderReviewError";
  }
}

/** The stored shape this election is resolved against. */
export interface OtherLodgeRateBooking {
  otherLodgeId: string | null;
  guests: ReadonlyArray<{
    id: string;
    isMember: boolean;
    otherLodgeMember: boolean;
    /**
     * Only ever used to NAME somebody in a refusal. Optional because both
     * production callers pass the stored guest rows, which carry them, while a
     * unit fixture asserting the election arithmetic need not.
     */
    firstName?: string | null;
    lastName?: string | null;
  }>;
}

/** "Ada Lovelace", or undefined when the row carries no usable name. */
function guestDisplayName(guest: {
  firstName?: string | null;
  lastName?: string | null;
}): string | undefined {
  return (
    [guest.firstName, guest.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" ") || undefined
  );
}

/**
 * The guests this booking may legitimately flag, resolved by
 * `resolveOtherLodgeRateEligibleGuestIds` (#2978).
 *
 * Passed in rather than derived here because the answer needs the season's
 * membership-type policies and the unpaid-subscription set, both of which are
 * database reads - and this resolver is deliberately synchronous and pure so
 * the preview and the save can run it over identical inputs. Callers resolve it
 * once, from the same helper the edit panel's tick boxes come from.
 */
export interface OtherLodgeRateEligibility {
  eligibleGuestIds: ReadonlySet<string>;
}

/** The two request fields, exactly as both routes' zod schemas parse them. */
export interface OtherLodgeRateInput {
  /**
   * The partner lodge for the whole booking. `undefined` means "this edit says
   * nothing about it" and leaves the stored value alone; `null` clears it, which
   * also clears every guest flag.
   */
  otherLodgeId?: string | null;
  /**
   * The complete end-state set of guests to price at the other-lodge member
   * rate — not a delta. A guest absent from a PRESENT array is unflagged, which
   * is what makes unticking somebody reprice them back to the non-member rate.
   * `undefined` means the edit says nothing about it.
   */
  otherLodgeMemberGuestIds?: string[];
}

export interface OtherLodgeRateElection {
  /** True when this request carried an election at all. */
  requested: boolean;
  /** The booking's partner lodge once this edit is saved. */
  otherLodgeId: string | null;
  /** Whether {@link otherLodgeId} differs from the stored value. */
  otherLodgeIdChanged: boolean;
  /** Every guest priced at the other-lodge member rate once this edit is saved. */
  flaggedGuestIds: ReadonlySet<string>;
  /**
   * Guests whose flag CHANGES in this request, in either direction.
   *
   * LOAD-BEARING: these are exactly the guests whose locked booked-night prices
   * must be cleared so the stay actually reprices. Leave the locks in place and
   * a tick changes nothing at all — every night stays pinned to the price it was
   * bought at (#1036) — which is the same trap the #2337 link had to avoid. It
   * cuts both ways here: unticking somebody whose nights are locked at the member
   * rate has to clear them too, or they never go back to the non-member rate.
   */
  repriceGuestIds: ReadonlySet<string>;
}

/**
 * Whether this request says anything about the other-lodge rate at all.
 *
 * Exported so a caller can skip resolving eligibility - two database reads -
 * on the overwhelming majority of modifications, which never mention it. That
 * matters most on the save path, where those reads would otherwise happen
 * inside the transaction holding the capacity lock. The resolver below uses the
 * same predicate, so "inert" means the same thing in both places.
 */
export function requestCarriesOtherLodgeElection(
  input: OtherLodgeRateInput,
): boolean {
  return (
    input.otherLodgeId !== undefined ||
    input.otherLodgeMemberGuestIds !== undefined
  );
}

/**
 * The fields that DISTURB a negotiated (quote-priced) booking's basis, in one
 * shape both the preview and the save can hand over.
 *
 * Named canonically here rather than taken from either caller's vocabulary: the
 * route destructures its zod body into `newCheckInStr`/`newPromoCode`, the batch
 * service reads `input.checkIn`/`input.promoCode`, and neither name is more
 * right than the other. Each caller maps its own locals onto these once.
 */
export interface OtherLodgeRateExemptionRequest extends OtherLodgeRateInput {
  checkIn?: unknown;
  checkOut?: unknown;
  addGuests?: { length: number } | null;
  removeGuestIds?: { length: number } | null;
  guestStayRanges?: { length: number } | null;
  promoCode?: unknown;
  removePromoCode?: unknown;
}

/**
 * Whether this request is an other-lodge election and NOTHING ELSE — the test
 * that exempts it from the quote-priced edit block (owner decision, 21 Aug 2026).
 *
 * WHY THE EXEMPTION EXISTS. A booking converted from a public request is
 * quote-priced: its guest rows carry a split of a total an officer negotiated,
 * and `QUOTE_PRICED_EDIT_BLOCK_MESSAGE` exists to stop an ordinary edit
 * disturbing that basis. But the public form is exactly where the "are you a
 * member of another lodge?" answer arrives, so a quote-priced booking is where
 * these guests come from — and the tick renegotiates nothing. It records that
 * somebody belongs to a partner lodge and applies the rate the club has already
 * agreed to give such people. That is the same character as the #2337
 * placeholder→member link, which is exempted here on the same reasoning and is
 * the precedent this follows.
 *
 * WHY IT IS ELECTION-ONLY, and why that fence is what makes it acceptable. Pair
 * the tick with a date move, a guest added or removed, a per-guest stay range or
 * a promotion and the negotiated basis really does move, so the block applies
 * again in full. Every guest the election does NOT name keeps their locked split
 * price untouched, because only the ticked and unticked rows have their locks
 * cleared — which is what confines the exemption to the one person it is about.
 *
 * ONE PREDICATE, CALLED FROM BOTH SIDES, and that is the point of it existing.
 * The preview (`modify-quote`) and the save (`modifyBookingBatch`) each used to
 * keep their own hand-written list of disturbing fields, and the save's list was
 * simply missing — so an election-only edit on a negotiated booking previewed
 * 200 and saved 400. Two lists drift; one cannot. Callers still apply their own
 * officer check on top, because "who may do this" is theirs to answer.
 */
export function requestIsOtherLodgeRateElectionOnly(
  input: OtherLodgeRateExemptionRequest,
): boolean {
  if (!requestCarriesOtherLodgeElection(input)) return false;
  return !(
    input.checkIn ||
    input.checkOut ||
    input.addGuests?.length ||
    input.removeGuestIds?.length ||
    input.guestStayRanges?.length ||
    input.promoCode ||
    input.removePromoCode
  );
}

/** The election a request that says nothing about the other-lodge rate produces. */
function inertElection(booking: OtherLodgeRateBooking): OtherLodgeRateElection {
  return {
    requested: false,
    otherLodgeId: booking.otherLodgeId,
    otherLodgeIdChanged: false,
    flaggedGuestIds: new Set(
      booking.guests.filter((guest) => guest.otherLodgeMember).map((guest) => guest.id),
    ),
    repriceGuestIds: new Set(),
  };
}

/**
 * Resolve the end state of the other-lodge rate election for one modification,
 * enforcing the fences the save path relies on.
 *
 * The gate is admin/officer-only, mirroring `resolveGuestMemberLinks`: this
 * re-rates a guest downward, so it must be unreachable from member self-service
 * however this resolver is reached, not merely hidden on the screen. The rest is
 * structural — a tick must name a guest on this booking, that guest must be one
 * the club may re-rate at all (#2978: they must currently price at the
 * non-member rate, which is NOT the same test as `!isMember`), and a tick with
 * no lodge behind it is refused so a booking can never carry a member-rated
 * guest with no club recorded against them.
 */
export function resolveOtherLodgeRateElection({
  booking,
  input,
  role,
  eligibleGuestIds,
}: {
  booking: OtherLodgeRateBooking;
  input: OtherLodgeRateInput;
  role: Role;
} & OtherLodgeRateEligibility): OtherLodgeRateElection {
  const mentionsLodge = input.otherLodgeId !== undefined;
  if (!requestCarriesOtherLodgeElection(input)) {
    return inertElection(booking);
  }

  if (role !== "ADMIN") {
    throw new ApiError(OTHER_LODGE_RATE_ADMIN_ONLY_MESSAGE, 403);
  }

  const otherLodgeId = mentionsLodge
    ? (input.otherLodgeId?.trim() || null)
    : booking.otherLodgeId;

  const guestsById = new Map(booking.guests.map((guest) => [guest.id, guest]));
  const flaggedGuestIds = new Set<string>();
  for (const guestId of input.otherLodgeMemberGuestIds ?? []) {
    const guest = guestsById.get(guestId);
    if (!guest) {
      throw new ApiError(OTHER_LODGE_RATE_GUEST_NOT_ON_BOOKING_MESSAGE, 400);
    }
    if (!eligibleGuestIds.has(guestId)) {
      throw new ApiError(
        otherLodgeRateIneligibleGuestMessage(guestDisplayName(guest)),
        400,
      );
    }
    flaggedGuestIds.add(guestId);
  }
  // Dropping the lodge drops every tick with it, in one direction only: a
  // request that clears the lodge AND names guests is a contradiction, refused
  // rather than silently half-applied.
  if (!otherLodgeId && flaggedGuestIds.size > 0) {
    throw new ApiError(OTHER_LODGE_RATE_LODGE_REQUIRED_MESSAGE, 400);
  }

  const repriceGuestIds = new Set<string>();
  for (const guest of booking.guests) {
    if (guest.otherLodgeMember !== flaggedGuestIds.has(guest.id)) {
      repriceGuestIds.add(guest.id);
    }
  }

  return {
    requested: true,
    otherLodgeId,
    otherLodgeIdChanged: otherLodgeId !== booking.otherLodgeId,
    flaggedGuestIds,
    repriceGuestIds,
  };
}

/**
 * Confirm a named partner lodge exists, so the save fails with a 400 the officer
 * can read rather than a foreign-key violation. Skipped entirely when the
 * election names no lodge or leaves the stored one alone.
 */
export async function assertOtherLodgeExists(
  db: Pick<Prisma.TransactionClient, "otherLodge">,
  otherLodgeId: string | null,
): Promise<void> {
  if (!otherLodgeId) return;
  const found = await db.otherLodge.findUnique({
    where: { id: otherLodgeId },
    select: { id: true },
  });
  if (!found) {
    throw new ApiError(OTHER_LODGE_RATE_LODGE_NOT_FOUND_MESSAGE, 400);
  }
}
