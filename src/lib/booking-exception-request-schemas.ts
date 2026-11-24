import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { dependantIdentityDeclarationSchema } from "@/lib/booking-dependant-identity";
import {
  BOOKING_PARTY_GUESTS_MAX,
  GUEST_CHANGE_LIST_BOUND,
  guestStayFieldsSchema,
} from "@/lib/booking-guest-stay-range-input";
import { nameField } from "@/lib/zod-helpers";

/**
 * The request bodies of the booking-policy exception requests (#2524, #2526):
 * asking an officer to allow a new booking or an edit the club's rules would
 * refuse, and withdrawing that request (ALP-794, `INV-SSOT`). The routes parse
 * with these, and the AI app catalogue offers the same fields.
 *
 * A guest's explicit night set (#713) rides in `guestStayFieldsSchema`, as on
 * create and `/modify`. REQUIRED, not a nicety (#2562 review): the wizard and
 * the edit panel send per-guest night sets in grid mode, and zod STRIPS
 * unknown keys, so omitting the field silently froze the whole envelope and
 * the officer reviewed nights nobody asked for.
 */

const exceptionRequestGuestSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  ageTier: bookableAgeTierEnum,
  isMember: z.boolean(),
  memberId: z.string().trim().min(1).optional(),
  ...guestStayFieldsSchema.shape,
});

/**
 * #2721, #3451 (`INV-GUEST-019`): the requester's answers to "this guest has
 * the same name as your own recorded dependant", re-verified by the service
 * against authoritative records. The cap is far above any real family and
 * stops a hostile payload turning the guard into an unbounded loop.
 */
const dependantIdentityDeclarationsSchema = z.array(dependantIdentityDeclarationSchema).max(50).optional();

/** `POST /api/bookings/exception-requests`: a new booking the rules would refuse. */
export const newBookingExceptionRequestSchema = z.object({
  lodgeId: z.string().trim().min(1).optional(),
  checkIn: z.string(),
  checkOut: z.string(),
  guests: z
    .array(exceptionRequestGuestSchema)
    .min(1)
    .max(...GUEST_CHANGE_LIST_BOUND),
  memberMessage: z.string().max(5000),
  dependantIdentityDeclarations: dependantIdentityDeclarationsSchema,
  supersedeRequestId: z.string().trim().min(1).optional(),
});

/** `POST /api/bookings/[id]/exception-requests`: an edit to a live booking the rules would refuse. */
export const modificationExceptionRequestSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(exceptionRequestGuestSchema)
    .max(...GUEST_CHANGE_LIST_BOUND)
    .optional(),
  removeGuestIds: z.array(z.string().trim().min(1)).max(...GUEST_CHANGE_LIST_BOUND).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().trim().min(1),
        ...guestStayFieldsSchema.shape,
      }),
    )
    .max(BOOKING_PARTY_GUESTS_MAX)
    .optional(),
  dependantIdentityDeclarations: dependantIdentityDeclarationsSchema,
  memberMessage: z.string().max(5000),
  supersedeRequestId: z.string().trim().min(1).optional(),
});

/**
 * What the AI app actions offer. The dependant-identity answers are left out:
 * they are the member's own declaration about a person (`declaration`), made
 * on the website, as `create_draft_booking` leaves them out (ALP-653).
 */
export const newBookingExceptionRequestConnectionSchema = newBookingExceptionRequestSchema.omit({
  dependantIdentityDeclarations: true,
});

export const modificationExceptionRequestConnectionSchema = modificationExceptionRequestSchema.omit({
  dependantIdentityDeclarations: true,
});

/** The withdraw `PATCH` on either kind: the only transition a member makes. */
export const exceptionRequestWithdrawSchema = z.object({ action: z.literal("cancel") });

/** The path of `PATCH /api/bookings/exception-requests/[id]`. */
export const exceptionRequestIdParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** The path of `PATCH /api/bookings/[id]/exception-requests/[requestId]`. */
export const bookingExceptionRequestParamsSchema = z.object({
  id: z.string().min(1).max(64),
  requestId: z.string().min(1).max(64),
});
