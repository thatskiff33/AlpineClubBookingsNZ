/**
 * The request schemas of the officer booking routes under
 * `/api/admin/bookings/**` (ALP-719, `INV-MCP-006`): the booking calendar and
 * search, and the officer tools on one booking.
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). Zod and client-safe
 * constants only: no database or server imports, so the catalogue can load it.
 */
import { z } from "zod";

import { OCCUPANCY_MONTH_PATTERN } from "@/lib/admin-bookings-schemas/occupancy";
import { BOOKING_FRESH_COPY_TEMPLATES } from "@/lib/booking-fresh-email-copy-templates";
import { nameField } from "@/lib/zod-helpers";

// ── The booking list and search ─────────────────────────────────────────────

/**
 * `GET /api/admin/bookings`: the month calendar. The route answers a missing
 * or malformed month with its own 400 text; the other fields are read as the
 * calendar page sends them.
 */
export const adminBookingsCalendarQuerySchema = z.object({
  calendarMonth: z
    .string()
    .regex(OCCUPANCY_MONTH_PATTERN)
    .describe("The calendar month, `YYYY-MM`."),
  status: z
    .string()
    .optional()
    .describe(
      "Booking statuses to show, comma separated (for example `PAID,PAYMENT_PENDING`; `DRAFT` must be named to see drafts). Left out or `all`, every status except DRAFT is shown.",
    ),
  deleted: z
    .string()
    .optional()
    .describe("Deleted bookings: `hide` (the default), `include` or `only`."),
  lodgeId: z
    .string()
    .optional()
    .describe("One lodge, from `list_lodges`, or `all`. Left out, every lodge's bookings are listed."),
});

/** `GET /api/admin/bookings/search`. */
export const adminBookingSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(2)
    .describe("At least 2 characters: the start of a booking id, or part of the booker's name or email, or a school's name."),
  limit: z.coerce.number().int().min(1).max(20).default(8).describe("How many bookings to answer with, 1 to 20; 8 by default."),
  deleted: z
    .enum(["hide", "include", "only"])
    .default("hide")
    .describe("Deleted bookings: `hide` (the default), `include` or `only`."),
});

// ── On-behalf pickers ───────────────────────────────────────────────────────

/** `GET /api/admin/bookings/eligible-family`. */
export const adminEligibleFamilyQuerySchema = z.object({
  forMemberId: z.string().min(1).describe("The member the officer is booking for."),
});

/** `GET /api/admin/bookings/non-member-contact`: dedupe suggestions. */
export const adminNonMemberContactQuerySchema = z.object({
  email: z.string().optional().describe("An email address, or the start of one (2 characters or more)."),
  name: z.string().optional().describe("Part of a first or last name (2 characters or more)."),
});

/**
 * `POST /api/admin/bookings/non-member-contact`, creating a new non-login
 * booking owner. Deliberately limited to name, email and phone (and the
 * no-email toggle): role, sign-in, email verification and age tier are not
 * accepted, so they only ever take their server-forced values.
 */
export const nonMemberContactCreateSchema = z
  .object({
    firstName: nameField(),
    lastName: nameField(),
    email: z.string().trim().max(320).email().optional(),
    phone: z.string().trim().max(50).optional(),
    // Walk-in without an email (D-R2): store a club-internal placeholder and
    // suppress all outbound email / Xero email-matching for this owner.
    noEmail: z
      .boolean()
      .optional()
      .default(false)
      .describe("True for a walk-in with no email address; `email` is then not needed."),
  })
  .refine((data) => data.noEmail || Boolean(data.email), {
    message: "An email address is required unless 'no email address' is set",
    path: ["email"],
  });

/** `POST /api/admin/bookings/non-member-contact`, picking an existing contact. */
export const nonMemberContactReuseSchema = z.object({
  useExistingContactId: z.string().min(1),
});

/** The route's whole body: pick an existing contact, or create one. */
export const nonMemberContactPostSchema = z.union([
  nonMemberContactReuseSchema,
  nonMemberContactCreateSchema,
]);

// ── Member guests ───────────────────────────────────────────────────────────

/**
 * `POST /api/admin/bookings/[id]/member-guest-candidates`, the exact-email
 * mode. The route treats any body this does not accept as an empty address
 * (an audited miss), never as a 400.
 */
export const adminMemberGuestEmailBodySchema = z.object({
  email: z.string().describe("The member's exact email address."),
});

/** `GET /api/admin/bookings/[id]/member-guest-candidates`, the name mode. */
export const adminMemberGuestNameQuerySchema = z.object({
  q: z
    .string()
    .optional()
    .describe("The start of a first or last name, or of both (2 characters or more)."),
});

// ── Officer tools on one booking ────────────────────────────────────────────

/** `POST /api/admin/bookings/[id]/copy`. */
export const adminBookingCopyBodySchema = z.object({
  checkIn: z.string().min(1).describe("The copy's check-in date, `YYYY-MM-DD`; the stay keeps its length."),
});

/**
 * `POST /api/admin/bookings/[id]/capacity-hold`. The route reads a body it
 * cannot parse as no overbook.
 */
export const adminCapacityHoldBodySchema = z.object({
  allowOverbook: z
    .boolean()
    .optional()
    .describe("True to place the hold even where it takes the lodge over capacity. Left out, an over-capacity hold is refused."),
});

/** `POST /api/admin/bookings/[id]/exclusive-hold`. */
export const adminExclusiveHoldBodySchema = z.object({
  hold: z.boolean().describe("True sets the exclusive whole-lodge hold; false clears it."),
});

/** `POST /api/admin/bookings/[id]/force-confirm`. */
export const adminForceConfirmBodySchema = z.object({
  allowOverbook: z
    .boolean()
    .optional()
    .describe("True to confirm even where it takes the lodge over capacity. Left out, an over-capacity confirm is refused."),
  // #1769b (#1705 semantics): per-action member-email choice. This route is
  // requireAdmin()-only, so no actor gate is needed. Absent = notify (default);
  // false suppresses the confirmation email (only reachable when the booking
  // lands PAID). A non-boolean value is rejected with 400.
  notifyMember: z
    .boolean()
    .optional()
    .describe("False to skip the confirmation email to the member. Left out, they are emailed."),
});

// The template is the ONLY input. `.strict()` refuses any other key, so a
// caller can never name a recipient, a body, a token or an amount: those are
// all read from the booking (or minted) by the service.
/** `POST /api/admin/bookings/[id]/fresh-email-copy`. */
export const adminFreshEmailCopyBodySchema = z
  .object({
    template: z
      .enum(BOOKING_FRESH_COPY_TEMPLATES)
      .describe(
        "Which email: `booking-confirmed`, `pre-arrival-reminder`, or `split-guest-payment-link` (a new payment link that replaces the old one).",
      ),
  })
  .strict();

export const adminNoEmailsBodySchema = z.object({
  noEmails: z.boolean().describe("True withholds every member email about this booking; false lets them go again."),
  // Owner decision D10: turning the switch ON requires an explicit
  // acknowledgement in the request body. Optional in the SHAPE so a request that
  // omits it gets the explanatory 400 below rather than a generic 422 — #2259
  // builds the dialog that sends it.
  acknowledged: z
    .boolean()
    .optional()
    .describe("Must be true to turn the switch on: the officer accepts the member will not be told about this booking."),
});

/** `PUT /api/admin/bookings/[id]/requested-room`. */
export const adminRequestedRoomBodySchema = z
  .object({ requestedRoomId: z.string().min(1).describe("The room the booking asks for, at the booking's lodge.") })
  .strict();
