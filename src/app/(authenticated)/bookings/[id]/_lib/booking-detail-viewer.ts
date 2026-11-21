import type { Prisma } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import type { auth } from "@/lib/auth";
import { hasAdminAccess } from "@/lib/access-roles";
import {
  bookingManagementAuthorizationRole,
  canSeeBookingAdminTools,
  hasAdminAreaAccess,
} from "@/lib/admin-permissions";
import type { BookingDetailRecord } from "./load-booking-detail";

export type BookingDetailSession = NonNullable<Awaited<ReturnType<typeof auth>>>;

/**
 * WHO IS LOOKING, and what that lets them do on this booking (#2958).
 *
 * Every viewer predicate the booking page gates on, resolved once from the
 * session and the loaded booking. Pure: it reads no database and redirects
 * nobody — the page keeps the `redirect("/bookings")` that sits between
 * `canViewAsAdmin` and `canAdminEditBookings` here, on exactly the three
 * predicates it always used. The authorization helpers this composes are the
 * canonical ones; nothing here re-derives a role.
 *
 * Moved verbatim from `page.tsx`, comments included.
 */
export function resolveBookingDetailViewer({
  session,
  booking,
}: {
  session: BookingDetailSession;
  booking: BookingDetailRecord;
}) {
  const isAdmin = hasAdminAccess(session.user);
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN
  // so the edit policy and the BookingEditor treat them as acting on-behalf of
  // the member — matching the widened /api/bookings/[id]/modify authority. A
  // Full Admin already resolves to ADMIN; member / read-only viewers stay USER.
  const viewerAuthorizationRole = bookingManagementAuthorizationRole(session.user);
  const isBookingOwner = bookingOwner(booking).memberId === session.user.id;
  // The viewer's OWN guest row, kept rather than thrown away: its consent state
  // decides what operational detail (the door code, below) this viewer may see.
  const viewerGuestRow =
    booking.guests.find((guest) => guest.memberId === session.user.id) ?? null;
  const isLinkedGuestViewer = !isBookingOwner && !isAdmin && viewerGuestRow !== null;
  const canManageBooking = isBookingOwner || isAdmin;
  // Issue #1289: Booking Officer / Read-only Admin reach the admin bookings
  // list and calendar (gated on bookings-area view), so the member-facing
  // detail route must admit the same viewers read-only for list/detail parity.
  // This is a genuinely read-only path (same shape as isLinkedGuestViewer):
  // every write/cancel/pay/modify/notes/admin-tools control below stays gated
  // on canManageBooking or isAdmin, so this predicate never widens a mutation.
  const canViewAsAdmin = hasAdminAreaAccess(session.user, {
    area: "bookings",
    level: "view",
  });
  // Issue #1313 (option A2): a Booking Officer (the ADMIN_BOOKINGS bundle carries
  // bookings:edit) may operate the admin-tooling cluster AND the member-facing
  // write controls on ANY booking, not just one they own. The admin-tooling
  // controls front routes under /api/admin/bookings/* (copy,
  // confirm-pending-guests, admin requested-room) that already authorize on
  // bookings:edit. The member-facing /api/bookings/[id]/* routes (cancel, modify,
  // notes, arrival-time) are now widened to also accept bookings:edit (this PR),
  // so their buttons include canAdminEditBookings and flow through the same
  // admin-on-behalf path as a Full Admin (see actingOnBehalf below) — the button
  // and its backing API widen together, never a button ahead of its route.
  const canAdminEditBookings = hasAdminAreaAccess(session.user, {
    area: "bookings",
    level: "edit",
  });
  // Full Admins and Booking Officers both see the admin-operational tooling.
  // #3278: the composition moved to `canSeeBookingAdminTools` so the member
  // bookings list can gate its money verdicts on the SAME predicate rather than
  // on a second spelling of it (`INV-SSOT`). Same answer as before, one home.
  const canSeeAdminTools = canSeeBookingAdminTools(session.user);
  // #3528: withdrawing an additional-payment request retires money
  // instruments, which is the payments board's authority (`finance:edit`),
  // not the booking officer's. The route re-checks the same permission.
  const canEditFinance = hasAdminAreaAccess(session.user, {
    area: "finance",
    level: "edit",
  });
  // Issue #1313 (option A2): a non-owner Full Admin OR Booking Officer cancels /
  // modifies on behalf of the member. Both flow through the SAME admin-on-behalf
  // semantics (suppress owner second-person framing, policy wording, and the
  // suppress-customer-notification path) rather than a separate officer code
  // path — so this one predicate replaces the earlier isAdmin-only actingAsAdmin.
  const actingOnBehalf = (isAdmin || canAdminEditBookings) && !isBookingOwner;
  // A non-owner admin-type viewer (Full Admin, Booking Officer, or read-only
  // admin) must not be addressed with owner second-person copy ("your place /
  // your stay") — issue #1289. Linked guests keep the member framing.
  const nonOwnerAdminViewer = !isBookingOwner && canViewAsAdmin;
  // #3991: WHO MAY SEE THE BOOKING OWNER'S MONEY BEYOND ITS PRICE — their
  // account credit (elected, applied, held or restored) and a refund still being
  // handed back to them: the owner, anyone who can manage the booking, and
  // admin-type viewers including read-only ones. In practice everyone the page
  // admits except a linked guest — and it is decided HERE, once, so a read-only
  // admin who is also a guest on the booking gets one answer on every surface.
  const canSeeOwnerCredit = canManageBooking || nonOwnerAdminViewer;
  return {
    isAdmin,
    viewerAuthorizationRole,
    isBookingOwner,
    viewerGuestRow,
    isLinkedGuestViewer,
    canManageBooking,
    canViewAsAdmin,
    canAdminEditBookings,
    canSeeAdminTools,
    canEditFinance,
    actingOnBehalf,
    nonOwnerAdminViewer,
    canSeeOwnerCredit,
  };
}

export type BookingDetailViewer = ReturnType<typeof resolveBookingDetailViewer>;

/**
 * A REMOVED booking this member would be let onto as its owner or as a guest on
 * it — the query form of `isBookingOwner || viewerGuestRow !== null` above, kept
 * beside it so the two answers cannot drift (owner decision 20 Nov 2026, #5266;
 * `INV-ADDPAY-034`).
 *
 * Role grants nothing here: a Booking Officer or read-only admin who is neither
 * the owner nor a guest is not entitled to be told what became of a removed
 * booking, and gets the same "not found" as a stranger. `memberId` is the owning
 * member, so an organisation-owned booking matches no member through this arm,
 * exactly as `bookingOwner(booking).memberId` never equals a member's id there.
 */
export function removedBookingEntitledViewerWhere(
  bookingId: string,
  viewerMemberId: string,
): Prisma.BookingWhereInput {
  return {
    id: bookingId,
    deletedAt: { not: null },
    OR: [
      { memberId: viewerMemberId },
      { guests: { some: { memberId: viewerMemberId } } },
    ],
  };
}
