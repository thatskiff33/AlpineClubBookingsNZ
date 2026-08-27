import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import type { MemberGuestConsentGuestFields } from "@/lib/member-guest-add-policy";
import { nameField } from "@/lib/zod-helpers";

// The request contract for `POST /api/bookings/[id]/modify-quote`, split
// verbatim out of that route (#3128) because none of it depends on a request:
// the schema, the date-only override field list and the normalised added-guest
// shape are static declarations that the handler reads, not code the handler
// composes. Nothing is re-exported from the route; it imports these directly.
//
// The three MOVE TOGETHER and must keep doing so.
// `OVERRIDE_DATE_ONLY_QUOTE_FIELDS` is an `as const` tuple whose members index
// `z.infer<typeof modifyQuoteSchema>` at the route's admin-override refusal, so
// a field renamed in one and not the other is a compile error rather than a
// silently skipped guard. Splitting them across two files would keep that
// working but put the two halves of one contract where a reader can change one
// without seeing the other.

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
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: z.array(z.string()).max(370).optional(),
      })
    )
    .optional(),
  removeGuestIds: z.array(z.string()).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().min(1),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: z.array(z.string()).max(370).optional(),
      })
    )
    .optional(),
  guestUpdates: z
    .array(
      z.object({
        guestId: z.string().min(1),
        firstName: nameField(),
        lastName: nameField(),
      })
    )
    .optional(),
  // #2337: mirror of the apply route's placeholder→member link so the preview
  // shows the same re-rate delta the save will settle. Gated identically.
  linkGuestToMember: z
    .array(
      z.object({
        guestId: z.string().min(1),
        memberId: z.string().min(1),
      })
    )
    .max(60)
    .optional(),
  // Other Lodges epic: mirror of the apply route's reciprocal other-club rate
  // election, so the preview prices the tick exactly as the save will charge it.
  // Both fields are an END STATE, never a delta — see booking-other-lodge-rate.ts.
  otherLodgeId: z.string().min(1).nullable().optional(),
  otherLodgeMemberGuestIds: z.array(z.string().min(1)).max(200).optional(),
  promoCode: z.string().optional(),
  // #2266 (MED-4): beneficiaries for guest-targeted promo codes, mirroring the
  // apply route — EXISTING guests bind by bookingGuestId (a stale id refuses
  // loudly instead of re-pointing the discount), and positional indexes exist
  // only for TO-BE-ADDED guests within this request, relative to addGuests.
  promoGuestIds: z.array(z.string().min(1)).max(200).optional(),
  promoAddedGuestIndexes: z.array(z.number().int().min(0)).max(200).optional(),
  removePromoCode: z.boolean().optional(),
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

export const OVERRIDE_DATE_ONLY_QUOTE_FIELDS = [
  "addGuests",
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
  // #1746: partner-shared flags ride guest changes, never a date override.
  "partnerSharedGuests",
] as const;

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
