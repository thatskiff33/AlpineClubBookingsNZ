import {
  grantBookingAdminDietaryAccess,
  isDietaryFieldEnabled,
  readBookingGuestDietaryForAdmin,
} from "@/lib/member-dietary";
import type { BookingDetailViewer } from "./booking-detail-viewer";
import type { BookingDetailRecord } from "./load-booking-detail";
import type { BookingGuestDietaryRow } from "../_components/booking-guest-dietary-card";

/**
 * The stay's dietary/allergy values for a BOOKING ADMINISTRATOR, or null for
 * every other viewer (#3029, `INV-PRIV-022`).
 *
 * Null is the whole privacy answer: the owner, a linked guest and a member
 * browsing their own booking get no key at all in this page's payload, because
 * `booking.guests` never carried the column (the client-wide omit) and this is
 * the only read that asks for it. The grant re-reads the viewer's access from
 * the database; the viewer flag only saves the read for somebody who plainly
 * cannot hold it. It returns ROWS, never the grant, so importing it hands
 * nobody a way to read another booking: the grant is minted for the session
 * user and spent here.
 */
export async function loadBookingDetailGuestDietary(input: {
  sessionUserId: string;
  booking: BookingDetailRecord;
  viewer: BookingDetailViewer;
}): Promise<{ canEdit: boolean; guests: BookingGuestDietaryRow[] } | null> {
  if (!input.viewer.canViewAsAdmin) return null;
  const enabled = await isDietaryFieldEnabled();
  if (!enabled) return null;
  const guard = { ok: true as const, session: { user: { id: input.sessionUserId } } };
  const editGrant =
    input.viewer.canAdminEditBookings && !input.booking.deletedAt
      ? await grantBookingAdminDietaryAccess(guard, "edit", { enabled })
      : null;
  const grant =
    editGrant ?? (await grantBookingAdminDietaryAccess(guard, "view", { enabled }));
  if (!grant) return null;
  const values = await readBookingGuestDietaryForAdmin(grant, input.booking.id);
  return {
    canEdit: editGrant !== null,
    guests: input.booking.guests.map((guest) => ({
      id: guest.id,
      firstName: guest.firstName,
      lastName: guest.lastName,
      isMember: guest.isMember,
      memberId: guest.memberId,
      ageTier: guest.ageTier,
      dietaryRequirements: values.get(guest.id) ?? null,
    })),
  };
}
