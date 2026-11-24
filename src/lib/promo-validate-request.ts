import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { BOOKING_PARTY_GUESTS_MAX, guestStayFieldsSchema } from "@/lib/booking-guest-stay-range-input";
import { modifyQuoteSchema } from "@/lib/booking-modify-quote-request";
import { parsedDateOnlySchema } from "@/lib/date-only-schema";

/**
 * `POST /api/promo-codes/validate`: what a promo code, several codes, or a
 * working bee would take off a stay before it is booked or edited (ALP-794,
 * `INV-SSOT`). The route parses with `promoValidateRequestSchema`; the AI app
 * preview `check_promo_code` offers the member's fields
 * (`promoValidateConnectionRequestSchema`).
 */

/**
 * The edit fields a preview request may carry, parsed exactly as the quote
 * parses them: the officer re-rates, and the removals and renames the link
 * resolver judges a link against (#4202). Read only with `bookingId`.
 */
export const promoPreviewEditFieldsSchema = modifyQuoteSchema.pick({
  linkGuestToMember: true,
  otherLodgeId: true,
  otherLodgeMemberGuestIds: true,
  removeGuestIds: true,
  guestUpdates: true,
});

/** What a member asks about their own stay or their own booking's edit. */
const promoValidateMemberShape = {
  code: z.string().min(1).optional(),
  // Work party (working bee) event preview: resolves the event's internal
  // promo server-side; the internal code is never sent to or accepted
  // from the client.
  workPartyEventId: z.string().min(1).optional(),
  checkIn: parsedDateOnlySchema,
  checkOut: parsedDateOnlySchema,
  guests: z
    .array(
      z.object({
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
        // #4199: Date In and Date Out, or the grid's night set (#713), so the
        // preview prices the nights the quote and the save price.
        ...guestStayFieldsSchema.shape,
        // #3827 (D-3813-4): optional, and it can only make a guest MORE
        // pending. Whether a guest awaits acceptance is decided server-side,
        // the way the create decides it; no client sends this today.
        awaitingAcceptance: z.boolean().optional(),
        // #3492: on an edit preview (`bookingId` below), the row this guest
        // already is on that booking, so their STORED consent is used — the
        // way `modify-quote` and the save judge them — instead of re-deciding
        // it as a fresh add. Ignored without an owned `bookingId`.
        bookingGuestId: z.string().min(1).max(64).optional(),
      })
    )
    .min(1).max(BOOKING_PARTY_GUESTS_MAX),
  promoGuestIndexes: z.array(z.number().int().min(0)).max(BOOKING_PARTY_GUESTS_MAX).optional(),
  // #3827: several codes, in the booker's order (D-3813-2), each with its own
  // guest choice. Combines with a working bee (D-3813-3). The response then
  // answers per code plus the booking's totals.
  codes: z
    .array(
      z.object({
        code: z.string().min(1).max(50),
        promoGuestIndexes: z.array(z.number().int().min(0)).max(BOOKING_PARTY_GUESTS_MAX).optional(),
      }),
    )
    .min(1)
    .max(20)
    .optional(),
  // Lodge the booking under quote is for (multi-lodge phase 8): promo lodge
  // restrictions and season pricing validate against it; omitted, the default
  // lodge. IGNORED on an edit (`bookingId`), which uses the booking's own (#4202).
  lodgeId: z.string().min(1).optional(),
  // WHICH KIND OF PURCHASE this preview is for (#2770, INV-MOD-026). This one
  // route serves both the create wizard (a first purchase) and the edit panel
  // (a later edit), and the two resolve their group discount through different
  // mappers, because the club's `applyToEdits` switch governs edits only. The
  // caller has to say which, because the route cannot tell from the body: the
  // guests, dates and code look the same either way.
  //
  // Optional and defaulting to a FIRST purchase, so every existing client — the
  // member wizard, the admin book page — keeps behaving exactly as it does now;
  // a `bookingId` implies an edit whatever this says (#4202). A client that lied
  // about this could only mislead ITSELF: the preview is never the charge.
  // `modify-quote` recomputes the promo on its own gated pricing and the save
  // path recomputes it again, so the money is decided there, not here (#1095).
  forBookingEdit: z.boolean().optional(),
  // #3492, #4199, #4202: the booking an EDIT preview is for, priced as the
  // quote prices it (`promoPreviewEditContext`): its owner, lodge, stored
  // rows (consent, nights, sold prices, flags) and its own promotion slots.
  // The caller must own it or hold the booking-management role, and any other
  // id answers exactly as a missing booking does (404), confirming nothing.
  bookingId: z.string().min(1).max(64).optional(),
};

/**
 * The whole request. `forMemberId` (an officer validating on a member's
 * behalf) and the officer re-rates are refused or ignored by the route for
 * anyone without the booking-management role.
 */
export const promoValidateRequestSchema = z
  .object({
    ...promoValidateMemberShape,
    forMemberId: z.string().optional(),
    ...promoPreviewEditFieldsSchema.shape,
  })
  .refine(
    (data) =>
      data.codes
        ? !data.code
        : Boolean(data.code) !== Boolean(data.workPartyEventId),
    {
      message: "Provide either a promo code or a working bee event, not both",
    },
  )
  .refine((data) => !data.workPartyEventId || Boolean(data.lodgeId), {
    message: "lodgeId is required for a working bee event",
    path: ["lodgeId"],
  });

/** `check_promo_code`: the member's own fields only. The route applies the two rules above. */
export const promoValidateConnectionRequestSchema = z.object(promoValidateMemberShape);
