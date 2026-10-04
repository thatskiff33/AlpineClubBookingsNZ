import { NextResponse } from "next/server";
import {
  bookingManagementAuthorizationRole,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";

/**
 * THE ONE "`forMemberId` is a booking officer's alone" refusal (#1442, #3492;
 * `INV-SSOT-001`). Booking on a member's behalf — creating, quoting, previewing a
 * promo code, or looking up that member's guests' codes — is open only to a
 * holder of the booking-management role (`bookings:edit`, which a Full Admin
 * carries). Anybody else naming a `forMemberId` is refused outright rather than
 * silently answered for themselves.
 *
 * Four doors ask it — `bookings`, `bookings/quote`, `promo-codes/validate` and
 * `promo-codes/guest-codes` — and every one answers the same status and words,
 * because the wording is all one place.
 */
export const ON_BEHALF_BOOKING_OFFICER_ONLY_MESSAGE =
  "Only admins can book on behalf of another member";

/** The 403 a non-officer's `forMemberId` earns, or null when it may proceed. */
export function refuseOnBehalfUnlessBookingOfficer(
  user: AdminPermissionInput,
  forMemberId: string | null | undefined,
): NextResponse | null {
  if (!forMemberId) return null;
  if (bookingManagementAuthorizationRole(user) === "ADMIN") return null;
  return NextResponse.json({ error: ON_BEHALF_BOOKING_OFFICER_ONLY_MESSAGE }, { status: 403 });
}
