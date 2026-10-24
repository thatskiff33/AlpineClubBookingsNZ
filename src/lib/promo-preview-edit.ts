import type { MemberGuestConsentStatus, Role } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-error";
import { bookingForPromoLookup } from "@/lib/promo-guest-codes";
// Through the barrel, as the quote reaches them, so the two cannot differ.
import {
  GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE,
  GUEST_MEMBER_LINK_MEMBER_WHOLE_LODGE_ONLY_MESSAGE,
  isMemberWholeLodgeBooking,
  resolveGuestMemberLinks,
} from "@/lib/booking-modify";
import {
  assertOtherLodgeExists,
  OtherLodgeRateInProgressError,
  requestCarriesOtherLodgeElection,
  resolveOtherLodgeRateElection,
} from "@/lib/booking-other-lodge-rate";
import { resolveOtherLodgeRateEligibleGuestIds } from "@/lib/membership-type-policy";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { clubTime } from "@/lib/club-time/server";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { modifyQuoteSchema } from "@/lib/booking-modify-quote-request";
import type { PromoPreviewEdit } from "@/lib/promo-preview-stay-ranges";

/**
 * The booking an edit's promo preview (`POST /api/promo-codes/validate` with a
 * `bookingId`) is for (#3492, #4199, #4202): the booking the quote
 * (`modify-quote`) and the save price, so the promo box prices it the way they
 * do.
 *
 * - `bookingId`, `ownerMemberId` and `lodgeId` are the booking's own. The quote
 *   judges the membership type and the promotion against the booking's OWNER
 *   (`null` for a school's booking, whose unassigned codes the engine then
 *   refuses), leaves the booking's own promotion slots out of the usage caps,
 *   and prices at the booking's lodge; the preview does the same, whoever is
 *   asking and whatever lodge or member the request names.
 * - Each row the request names is read for its stored consent, which the
 *   preview judges that guest by; its stay, which the modification planner
 *   keeps for a guest the edit sends no dates for; the price each night was sold
 *   at, which the pricing pass keeps for every night the guest still holds
 *   (#1036); and its other-lodge flag.
 * - The two officer re-rates the quote is sent — a #2337 placeholder-to-member
 *   link and the other-lodge election — are resolved by the SAME resolvers the
 *   quote and the save run (`resolveGuestMemberLinks`, judged against the same
 *   removals and renames, and `resolveOtherLodgeRateElection`), so the preview
 *   re-rates exactly the guests they re-rate: a linked guest prices as the
 *   member with their locks cleared, and a ticked or unticked guest takes the
 *   election's flag with their locks cleared. The refusals those resolvers raise
 *   are the quote's, word for word, and so are its member-origin fence on a
 *   link (a school's whole-lodge booking may not link) and its two mid-stay
 *   refusals of a re-rate (`GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE`,
 *   `OtherLodgeRateInProgressError`), judged on the same edit policy.
 *
 * NOT MIRRORED, and why. The box does not mirror the quote's refusal of any
 * code change on a stay already under
 * way (the panel hides the box there; a direct caller is answered about the
 * code), or the quote's other refusals of a whole edit (its status and date
 * windows, capacity, policy exceptions): it answers about a code, and the quote
 * beside it says why the edit itself cannot be saved.
 */
export type PromoPreviewEditContext = {
  bookingId: string;
  /** The caller's booking-management role: an officer acts on the owner's behalf, as on the quote. */
  role: Role;
  ownerMemberId: string | null;
  lodgeId: string;
  consentById: Map<string, { memberId: string | null; consentStatus: MemberGuestConsentStatus | null }>;
  edit: PromoPreviewEdit;
};

/**
 * The edit fields a preview request may carry, parsed exactly as the quote
 * parses them: the officer re-rates, and the removals and renames the link
 * resolver judges a link against.
 */
export const promoPreviewEditFieldsSchema = modifyQuoteSchema.pick({
  linkGuestToMember: true,
  otherLodgeId: true,
  otherLodgeMemberGuestIds: true,
  removeGuestIds: true,
  guestUpdates: true,
});

export type PromoPreviewEditRequest = z.infer<typeof promoPreviewEditFieldsSchema> & {
  guests: ReadonlyArray<{ bookingGuestId?: string }>;
};

/**
 * `null` both for a booking that does not exist and for one the caller may not
 * read (`bookingForPromoLookup`), so the route answers both with one 404. A
 * re-rate the quote would refuse comes back as `refusal`, with its status.
 */
export async function promoPreviewEditContext(params: {
  bookingId: string;
  actorMemberId: string;
  role: Role;
  request: PromoPreviewEditRequest;
}): Promise<PromoPreviewEditContext | { refusal: { message: string; status: number } } | null> {
  const booking = await bookingForPromoLookup({
    bookingId: params.bookingId,
    actorMemberId: params.actorMemberId,
    isBookingOfficer: params.role === "ADMIN",
  });
  if (!booking) return null;
  let rerates: Rerates;
  try {
    rerates = await resolveRerates(booking, params.role, params.request);
  } catch (error) {
    if (error instanceof ApiError) return { refusal: { message: error.message, status: error.status } };
    throw error;
  }
  const bookingGuestIds = params.request.guests.flatMap((guest) => (guest.bookingGuestId ? [guest.bookingGuestId] : []));
  const rows = bookingGuestIds.length
    ? await prisma.bookingGuest.findMany({
        where: { bookingId: booking.id, id: { in: bookingGuestIds } },
        select: {
          id: true,
          memberId: true,
          consentStatus: true,
          otherLodgeMember: true,
          stayStart: true,
          stayEnd: true,
          // #4317: the stored total, which the valued locks reconcile to.
          priceCents: true,
          nights: { select: { stayDate: true, priceCents: true, priceSource: true } },
        },
      })
    : [];
  return {
    bookingId: booking.id,
    role: params.role,
    ownerMemberId: booking.ownerMemberId,
    lodgeId: booking.lodgeId,
    consentById: new Map(rows.map((row) => [row.id, { memberId: row.memberId, consentStatus: row.consentStatus }])),
    edit: {
      booking: { checkIn: booking.checkIn, checkOut: booking.checkOut },
      storedGuests: rows.map(({ id, memberId, otherLodgeMember, stayStart, stayEnd, priceCents, nights }) => ({
        id,
        memberId,
        stayStart,
        stayEnd,
        priceCents,
        nights,
        otherLodgeMember: rerates.flaggedGuestIds ? rerates.flaggedGuestIds.has(id) : otherLodgeMember,
        repricedDeliberately: rerates.repriceGuestIds.has(id),
        linkedMemberId: rerates.linkedMemberByGuestId.get(id),
      })),
    },
  };
}

type Rerates = {
  /** The election's end state, or null when the request carries none (stored flags stand). */
  flaggedGuestIds: ReadonlySet<string> | null;
  /** Every guest whose locks the quote clears: linked, ticked or unticked. */
  repriceGuestIds: ReadonlySet<string>;
  linkedMemberByGuestId: ReadonlyMap<string, string>;
};

/**
 * The quote's own resolution of the two re-rates, over the whole stored party
 * (both resolvers judge every guest on the booking, not just the ones named).
 * Nothing is read when the request carries neither, which is every member's
 * preview.
 */
async function resolveRerates(
  booking: { id: string; checkIn: Date },
  role: Role,
  request: PromoPreviewEditRequest,
): Promise<Rerates> {
  const carriesElection = requestCarriesOtherLodgeElection(request);
  if (!request.linkGuestToMember?.length && !carriesElection) {
    return { flaggedGuestIds: null, repriceGuestIds: new Set(), linkedMemberByGuestId: new Map() };
  }
  const stored = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: { status: true, checkOut: true, wholeLodgeHold: true, otherLodgeId: true, guests: true },
  });
  if (!stored) throw new ApiError("Booking not found", 404);
  // The quote's member-origin fence, raised before its resolver as the quote raises it.
  if (request.linkGuestToMember?.length && !(await isMemberWholeLodgeBooking(prisma, booking.id))) {
    throw new ApiError(GUEST_MEMBER_LINK_MEMBER_WHOLE_LODGE_ONLY_MESSAGE, 400);
  }
  const links = resolveGuestMemberLinks({
    booking: stored,
    input: {
      linkGuestToMember: request.linkGuestToMember,
      removeGuestIds: request.removeGuestIds,
      guestUpdates: request.guestUpdates,
    },
    role,
  });
  const linkedMemberByGuestId = new Map(links.map((link) => [link.guestId, link.memberId]));
  // As the quote does: eligibility costs reads, so only for an officer's
  // election, and judged on the booking's season once the club's financial
  // year is loaded (the quote reseeds it first through the lockout mode).
  let eligibleGuestIds = new Set<string>();
  if (role === "ADMIN" && carriesElection) {
    await refreshFinancialYearConfig();
    eligibleGuestIds = await resolveOtherLodgeRateEligibleGuestIds(prisma, {
      seasonYear: seasonYearOfStoredDate(booking.checkIn),
      guests: stored.guests,
    });
  }
  const election = resolveOtherLodgeRateElection({
    booking: stored,
    input: { otherLodgeId: request.otherLodgeId, otherLodgeMemberGuestIds: request.otherLodgeMemberGuestIds },
    role,
    eligibleGuestIds,
    linkedGuestIds: new Set(linkedMemberByGuestId.keys()),
  });
  await assertOtherLodgeExists(prisma, election.otherLodgeId);
  // The quote's mid-stay refusals of a re-rate, on its own edit policy: the
  // in-progress plan prices the stored rows, so a re-rate there would show $0.
  // The box is never sent the officer's date override (the panel hides the box
  // while it is on), so no override is judged here.
  const editPolicy = getBookingEditPolicy({
    status: stored.status,
    role,
    checkIn: booking.checkIn,
    checkOut: stored.checkOut,
    today: dateOnlyInstantOf((await clubTime()).today()),
  });
  if (editPolicy.mode === "in-progress") {
    if (links.length > 0) throw new ApiError(GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE, 400);
    if (carriesElection) throw new OtherLodgeRateInProgressError();
  }
  return {
    flaggedGuestIds: carriesElection ? election.flaggedGuestIds : null,
    repriceGuestIds: new Set([...linkedMemberByGuestId.keys(), ...election.repriceGuestIds]),
    linkedMemberByGuestId,
  };
}
