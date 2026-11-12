import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { dependantIdentityDeclarationSchema } from "@/lib/booking-dependant-identity";
import type { MemberGuestConsentGuestFields } from "@/lib/member-guest-add-policy";
import { nameField } from "@/lib/zod-helpers";
import { GUEST_CHANGE_LIST_BOUND, BOOKING_PARTY_GUESTS_MAX, guestStayFieldsSchema } from "@/lib/booking-guest-stay-range-input";

// The request contract shared by `POST /api/bookings/[id]/modify-quote` (the
// preview) and `PUT /api/bookings/[id]/modify` (the save). Split out of the
// preview route (#3128); since #4924 the save's schema is THIS schema extended
// with its save-only answers (`batchModifySchema` in
// `booking-modify-request.ts`), so a field is declared once and both doors parse
// it identically (`INV-SSOT-001`). The date-only override list and its
// predicate are likewise the one copy both routes call.
//
// `OVERRIDE_DATE_ONLY_FIELDS` is an `as const` tuple whose members index
// `z.infer<typeof modifyQuoteSchema>`, so a field renamed in one and not the
// other is a compile error rather than a silently skipped guard.

/**
 * #3827: an edit's code list — every code the booking should carry afterwards,
 * in the booker's order (D-3813-2). Shared by the preview and the save so the
 * two parse it identically. `promoGuestIds` / `promoAddedGuestIndexes` bind a
 * booker-picks-guests choice exactly as the legacy fields do (#2266).
 */
export const editPromoCodesSchema = z
  .array(
    z.object({
      code: z.string().min(1).max(50),
      promoGuestIds: z.array(z.string().min(1)).max(BOOKING_PARTY_GUESTS_MAX).optional(),
      promoAddedGuestIndexes: z.array(z.number().int().min(0)).max(...GUEST_CHANGE_LIST_BOUND).optional(),
    }),
  )
  .max(20)
  .optional();

export const modifyQuoteSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
        ...guestStayFieldsSchema.shape,
      })
    )
    .max(...GUEST_CHANGE_LIST_BOUND).optional(),
  // #3451 (`INV-GUEST-019`): the member's answer "this is a different person with
  // the same name" about one of the booking owner's recorded dependants, for an
  // ADDED guest whose name matches. The same shape the create route takes; the
  // route re-derives every collision from authenticated data and refuses a
  // declaration that does not describe one.
  dependantIdentityDeclarations: z
    .array(dependantIdentityDeclarationSchema)
    .max(50)
    .optional(),
  removeGuestIds: z.array(z.string()).max(...GUEST_CHANGE_LIST_BOUND).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().min(1),
        ...guestStayFieldsSchema.shape,
      })
    )
    .max(BOOKING_PARTY_GUESTS_MAX).optional(),
  guestUpdates: z
    .array(
      z.object({
        guestId: z.string().min(1),
        firstName: nameField(),
        lastName: nameField(),
      })
    )
    .max(...GUEST_CHANGE_LIST_BOUND).optional(),
  // #2337: mirror of the apply route's placeholder→member link so the preview
  // shows the same re-rate delta the save will settle. Gated identically.
  linkGuestToMember: z
    .array(
      z.object({
        guestId: z.string().min(1),
        memberId: z.string().min(1),
      })
    )
    .max(60).optional(),
  // Other Lodges epic: mirror of the apply route's reciprocal other-club rate
  // election, so the preview prices the tick exactly as the save will charge it.
  // Both fields are an END STATE, never a delta — see booking-other-lodge-rate.ts.
  otherLodgeId: z.string().min(1).nullable().optional(),
  otherLodgeMemberGuestIds: z.array(z.string().min(1)).max(BOOKING_PARTY_GUESTS_MAX).optional(),
  promoCode: z.string().optional(),
  // #2266 (MED-4): beneficiaries for guest-targeted promo codes, mirroring the
  // apply route — EXISTING guests bind by bookingGuestId (a stale id refuses
  // loudly instead of re-pointing the discount), and positional indexes exist
  // only for TO-BE-ADDED guests within this request, relative to addGuests.
  promoGuestIds: z.array(z.string().min(1)).max(BOOKING_PARTY_GUESTS_MAX).optional(),
  promoAddedGuestIndexes: z.array(z.number().int().min(0)).max(...GUEST_CHANGE_LIST_BOUND).optional(),
  removePromoCode: z.boolean().optional(),
  // #3827: the complete list of codes after the edit, in the booker's order —
  // the same field, and the same schema, the apply route takes.
  promoCodes: editPromoCodesSchema,
  // #2266: the member's credit election, mirroring the create quote/create
  // routes. The preview never moves money — the apply route stores the election
  // on the booking (Booking.creditElectionCents, #2265) and the pay step
  // consumes it — so the preview only has to keep the request price-preserving
  // when credit is the ONLY change.
  applyCreditCents: z.number().int().min(0).max(100_000_000).optional(),
  // Admin-only date override (issue #1668). The preview mirrors apply exactly.
  adminOverride: z.boolean().optional(),
  pricingMode: z.enum(["shift", "recalculate"]).optional(),
  confirmOverCapacity: z.boolean().optional(),
  // Admin-only (#1746): mirror of the apply route's partner-sharer flags so
  // the preview reflects the #1745 reserved-slot outcome.
  partnerSharedGuests: z
    .array(
      z.object({
        memberId: z.string().min(1),
        partnerMemberId: z.string().min(1),
      }),
    )
    .max(10)
    .optional(),
});

export const OVERRIDE_DATE_ONLY_FIELDS = [
  "addGuests",
  // #3451: an answer about an added guest is a guest change, never a date override.
  "dependantIdentityDeclarations",
  "removeGuestIds",
  "guestStayRanges",
  "guestUpdates",
  // #2337: a placeholder→member link is a guest change, never a date override.
  "linkGuestToMember",
  // The other-lodge rate election re-rates guests, so it is a guest change too.
  "otherLodgeId",
  "otherLodgeMemberGuestIds",
  "promoCode",
  "promoGuestIds",
  "promoAddedGuestIndexes",
  "removePromoCode",
  "promoCodes",
  // #1746: partner-shared flags ride guest changes, never a date override.
  "partnerSharedGuests",
] as const;

/**
 * Whether an admin date-only override (#1668) carries anything but dates. An
 * empty list changes nothing, so it passes.
 */
export function isDateOnlyOverrideViolation(
  data: Partial<Record<keyof z.infer<typeof modifyQuoteSchema>, unknown>>,
): boolean {
  return (
    OVERRIDE_DATE_ONLY_FIELDS.some((field) => {
      const value = data[field];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    }) ||
    // #2266: checked explicitly — `Boolean(0)` is false, so a credit election
    // of 0 cents would otherwise slip past the date-only contract.
    data.applyCreditCents !== undefined ||
    // Same trap, same fix: `otherLodgeId: null` CLEARS the election and is
    // falsy, so the list membership above would let it through.
    data.otherLodgeId !== undefined
  );
}

/**
 * #4924 (`INV-MOD-062`): the preview's figures, returned as `quotedFigures` and
 * sent back unchanged on Save, where the save refuses if its own differ.
 * Integer cents; `netChargeCents` is before the unpaid-ask offset.
 */
export const editQuotedFiguresSchema = z.object({
  newFinalPriceCents: z.number().int(),
  priceDiffCents: z.number().int(),
  changeFeeCents: z.number().int(),
  netChargeCents: z.number().int(),
});

export type EditQuotedFigures = z.infer<typeof editQuotedFiguresSchema>;

export type NormalizedAddGuest = MemberGuestConsentGuestFields & {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: ReadonlyArray<string> | null;
};
