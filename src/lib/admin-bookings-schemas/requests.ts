/**
 * The request schemas of the officer booking-request routes under
 * `/api/admin/booking-requests/**` (ALP-719, `INV-MCP-006`): the queue of
 * group, school and whole-lodge requests, and the officer's steps on one
 * request (price, quote, hold, send, approve).
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). Zod, Prisma enums and
 * client-safe helpers only: no database or server imports, so the catalogue
 * can load it. The school group numbers and the member whole-lodge approval
 * override moved here from `school-booking-request.ts`, and the quote body
 * from `booking-request-quotes.ts`; those services import them from here.
 */
import {
  AgeTier,
  BookingRequestPricingMode,
  BookingRequestStatus,
  SchoolCateringOption,
} from "@prisma/client";
import { z } from "zod";

import { adminListPageQueryFields, adminQueueFocusIdField } from "@/lib/admin-list-page";
import { schoolTeacherSchema } from "@/lib/school-teacher-schema";

// ── Shared pieces ───────────────────────────────────────────────────────────

/**
 * A school group's bulk child numbers. One shape for the school's own form,
 * the officer's Save quote, Send quote, correction and approval, so the same
 * numbers reach all of them (#3412).
 */
export const schoolChildCountsSchema = z
  .object({
    INFANT: z.number().int().min(0).max(200).optional(),
    CHILD: z.number().int().min(0).max(200).optional(),
    YOUTH: z.number().int().min(0).max(200).optional(),
  })
  .describe(
    "School groups only: the number of infants, children and youth in the group, 0 to 200 each. Left out, the numbers stored on the request stand.",
  );

export type SchoolChildCounts = z.infer<typeof schoolChildCountsSchema>;

/**
 * The map-to-existing-contact decision (#1255) as approve and Send quote
 * read it: a non-blank id of at most 64 characters. The authoritative guard
 * (a non-login organisation or school contact, not archived) runs inside the
 * service's transaction.
 */
export const bookingRequestOwnerContactIdSchema = z
  .string()
  .max(64)
  .refine((value) => value.trim().length > 0)
  .describe(
    "An existing non-member contact (from `list_booking_request_contacts`) to own the booking instead of creating a new one. Left out, a new contact is created from the request.",
  );

// ── The queue ───────────────────────────────────────────────────────────────

const bookingRequestQueueStatusValues = [...Object.values(BookingRequestStatus), "QUEUE", "ALL"] as const;

/** `GET /api/admin/booking-requests`. */
export const adminBookingRequestQueueQuerySchema = z.object({
  status: z
    .enum(bookingRequestQueueStatusValues)
    .optional()
    .default("QUEUE")
    .describe(
      "Which requests: `QUEUE` (the default: verified requests waiting for the officer, oldest first), `ALL`, or one request status such as `VERIFIED`, `PRICED`, `QUOTE_SENT`, `ACCEPTED`, `DECLINED` or `CONVERTED`.",
    ),
  ...adminListPageQueryFields,
  requestId: adminQueueFocusIdField.describe("One request's id, to read just that request."),
});

/** `GET /api/admin/booking-requests/[id]/contacts`. */
export const adminBookingRequestContactsQuerySchema = z.object({
  q: z
    .string()
    .optional()
    .describe(
      "Part of a contact's name or email (2 characters or more). Left out, contacts matching the request's own contact email, names and school name are suggested.",
    ),
});

/** `GET /api/admin/booking-requests/[id]/school-record`. */
export const adminBookingRequestSchoolRecordQuerySchema = z.object({
  name: z
    .string()
    .optional()
    .describe("A school name to check. Left out, the school name already on the request is checked."),
});

// ── Pricing and quoting ─────────────────────────────────────────────────────

/** `POST /api/admin/booking-requests/[id]/price`. */
export const adminBookingRequestPriceBodySchema = z.object({
  priceCents: z.number().int().min(0).describe("The officer's price for the whole stay, in integer cents."),
});

/** One nightly rate of a per-guest-night quote option; also the stored option's shape. */
export const bookingRequestGuestNightRateSchema = z.object({
  ageTier: z.enum(AgeTier).describe("The age group the rate is for."),
  isMember: z.boolean().describe("True for the rate of a guest linked to a club member."),
  rateCents: z.number().int().min(0).describe("The nightly rate, in integer cents."),
});

const bookingRequestQuoteOptionInputSchema = z.object({
  id: z.string().min(1).max(40).optional().describe("The option's id, to keep it across saves."),
  cateringOption: z
    .enum(SchoolCateringOption)
    .optional()
    .nullable()
    .describe("School groups: the catering this option prices."),
  totalCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("With `pricingMode` `OVERALL_TOTAL`: the option's total, in integer cents."),
  guestNightRates: z
    .array(bookingRequestGuestNightRateSchema)
    .optional()
    .describe("With `pricingMode` `PER_GUEST_NIGHT`: the nightly rate for each age group, member and non-member."),
});

/** `POST /api/admin/booking-requests/[id]/quote` (Save quote). */
export const bookingRequestQuoteInputSchema = z.object({
  pricingMode: z
    .enum(BookingRequestPricingMode)
    .describe("`OVERALL_TOTAL` for one price per option, or `PER_GUEST_NIGHT` for nightly rates per age group."),
  options: z
    .array(bookingRequestQuoteOptionInputSchema)
    .min(1)
    .max(2)
    .describe("One or two priced options the requester chooses between."),
  message: z
    .string()
    .max(2000)
    .optional()
    .nullable()
    .describe("A note to the requester, shown with the quote."),
  linkedGuestMembers: z
    .array(
      z.object({
        guestIndex: z.number().int().min(0).describe("The guest's position in the request's guest list, from 0."),
        memberId: z.string().min(1).describe("The club member that guest is."),
      }),
    )
    .optional()
    .describe(
      "Which guests are club members. Replaces the request's links: send the request's current `linkedGuestMembers` to keep them; left out, every link is removed.",
    ),
  /**
   * #3412 — the officer's adjusted bulk child counts on a SCHOOL request, in
   * the SAME schema approval takes, because it is the same decision made
   * earlier. Present only when the officer edited the group-number boxes.
   * Saving the quote is where that edit becomes real: the guest list is
   * regenerated and PERSISTED on the request in the quote's own transaction, so
   * the price, the requester's breakdown, the guest count in the email, the
   * send-time hold and the approval all read one list.
   */
  childCounts: schoolChildCountsSchema.optional(),
});

/** `POST /api/admin/booking-requests/[id]/send-quote`. */
export const adminBookingRequestSendQuoteBodySchema = z.object({
  ownerContactMemberId: bookingRequestOwnerContactIdSchema.nullish(),
  childCounts: schoolChildCountsSchema
    .nullish()
    .describe(
      "School groups: the group numbers the officer last saw. Refused when they differ from the numbers saved on the request; save a quote first.",
    ),
});

/** `POST /api/admin/booking-requests/[id]/link-conflicts`. */
export const adminBookingRequestLinkConflictsBodySchema = z.object({
  links: z
    .array(
      z.object({
        guestIndex: z.number().int().min(0).describe("The guest's position in the request's guest list, from 0."),
        memberId: z.string().min(1).describe("The club member to check for that guest."),
      }),
    )
    .max(200)
    .default([])
    .describe("The guest-to-member links to check."),
});

// ── Holding beds and approving ──────────────────────────────────────────────

/** `POST /api/admin/booking-requests/[id]/hold`. */
export const adminBookingRequestHoldBodySchema = z.object({
  optionId: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .nullable()
    .describe("The quote option whose party and price the hold carries. Left out, the accepted or only option."),
  // Optional map-to-existing-contact decision (issue #1255). The authoritative
  // guard runs inside the hold transaction.
  ownerContactMemberId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .nullable()
    .describe(
      "An existing non-member contact (from `list_booking_request_contacts`) to own the held booking instead of creating a new one.",
    ),
});

/**
 * Admin override of the approved headcount, and the manual price, for a member
 * whole-lodge request (#2263). Validated in the approve route exactly like the
 * school `childCounts` override.
 */
export const memberWholeLodgeApprovalSchema = z.object({
  /**
   * The headcount the officer is actually pricing and booking, after talking to
   * the member. Omitted keeps the submitted approximate number.
   */
  pricedHeadcount: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Member whole-lodge requests only: the headcount to price and book. Left out, the member's own number."),
  /**
   * Manual total price in integer cents. MANDATORY fallback when no active
   * season covers the requested dates — without it the season-rate branch has
   * nothing to price from and the approval 409s (the member-request path has no
   * quote/price op to fall back on, so this field is the only way through).
   * Split across the guest rows by splitPriceAcrossGuests.
   */
  priceOverrideCents: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .optional()
    .describe(
      "Member whole-lodge requests only: the total price in integer cents, instead of season rates. Needed when no season covers the dates.",
    ),
  /**
   * The officer's per-approval pricing choice (#2338). When true and a flat
   * whole-lodge rate is set for every night's covering season, the stay prices
   * `nights x flat rate` and headcount is ignored; otherwise it falls back to
   * per-guest pricing (owner decision 1 Aug 2026: the officer chooses per
   * approval, it is NOT automatic on every whole-lodge booking). Omitted/false
   * keeps today's per-guest behaviour so nothing changes silently. The manual
   * `priceOverrideCents` still wins over both.
   */
  priceAsWholeLodge: z
    .boolean()
    .optional()
    .describe(
      "Member whole-lodge requests only: true to price at the flat whole-lodge night rate when one covers every night (`wholeLodgeFlatTotalCents` on the request).",
    ),
});

/**
 * `POST /api/admin/booking-requests/[id]/approve`. Which fields apply depends
 * on the request: the route reads each one on its own branch, with these same
 * schemas, and ignores the rest.
 */
export const adminBookingRequestApproveBodySchema = z.object({
  ownerContactMemberId: bookingRequestOwnerContactIdSchema.nullish(),
  childCounts: schoolChildCountsSchema.optional(),
  ...memberWholeLodgeApprovalSchema.shape,
});

/** `POST /api/admin/booking-requests/[id]/resolve-pending-adults`. */
export const adminBookingRequestResolvePendingAdultsBodySchema = z.object({
  expectedVersion: z
    .number()
    .int()
    .min(0)
    .describe("The request's `version` as last read; refused when the request has changed since."),
  teachers: z
    .array(schoolTeacherSchema)
    .min(1)
    .max(50)
    .describe(
      "The real names for the request's pending adults, no more than its `pendingAdultCount`: first name, last name and optional email, each different from the named teachers already on it.",
    ),
});
