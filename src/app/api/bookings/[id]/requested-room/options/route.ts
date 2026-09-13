import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { hasAdminAccess } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { auth } from "@/lib/auth";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";

/**
 * GET /api/bookings/[id]/requested-room/options — the rooms a booking's
 * requested-room picker may offer (#2664).
 *
 * WHY THIS ROUTE EXISTS. The editor used to load its choices from
 * `/api/bookings/rooms` with no scope at all, and that endpoint's no-`lodgeId`
 * mode lists active rooms across EVERY lodge the caller is personally eligible
 * to book. Two things went wrong with that on a multi-lodge club:
 *
 *  1. It offered rooms from the wrong lodge. `writeRequestedRoom()` re-reads the
 *     booking under the booking writer lock and refuses any room whose
 *     `lodgeId` is not the booking's, so the picker presented a lodge B room on
 *     a lodge A booking and the save was then correctly refused — which a member
 *     experiences as a control that does not work.
 *  2. It used the WRONG AUTHORITY for staff. The same component serves the
 *     admin/Booking Officer edit on the booking detail page; only its *write*
 *     endpoint changes between the member and admin paths. So an officer
 *     editing on someone else's behalf had their choices filtered — or refused
 *     outright — by their own personal `isMemberEligibleToBookLodge` result,
 *     even though the write is authorised through the booking/admin path.
 *
 * THE CONTRACT. The lodge is derived SERVER-SIDE from the booking being edited;
 * no caller-supplied `lodgeId` is accepted or consulted, so there is nothing for
 * a client to lie about. Authority is the booking's own boundary — the owner, a
 * Full Admin, or a Booking Officer holding `bookings:edit` — which is the exact
 * union of the two requested-room write routes this editor posts to
 * (`/api/bookings/[id]/requested-room`, owner-or-Full-Admin, and
 * `/api/admin/bookings/[id]/requested-room`, `bookings:edit`), and the same
 * predicate the sibling arrival-time route on this page already uses (#1313
 * option A2). Member booking eligibility (`isMemberEligibleToBookLodge`) is
 * deliberately NOT consulted: this is not lodge discovery, it is one booking
 * that already exists at one lodge, and the caller has just been shown that
 * booking.
 *
 * THIS IS UX CORRECTNESS, NOT A SECURITY BOUNDARY FOR THE WRITE. The writer
 * stays authoritative and keeps its under-lock room/lodge validation; narrowing
 * the read only stops the editor offering a room the writer would refuse.
 *
 * THE STORED INACTIVE ROOM IS NOT RETURNED HERE, deliberately. A booking may
 * hold a room the club has since retired, and it must still be shown as the
 * value on record — but as the stored value, never as a fresh selectable choice.
 * The editor already receives it from the server-rendered booking page
 * (`initialRoom`) and renders it through its own `storedInactiveOption`, so
 * putting it in this list would do the one thing the list must not do: make a
 * retired room look pickable. This response is therefore exactly "the rooms this
 * booking may newly request".
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  // The booking first: its lodge is the scope, and its owner is the authority.
  // Nothing about rooms is read until both have been established.
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { memberId: true, lodgeId: true, deletedAt: true },
  });
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (
    bookingOwner(booking).memberId !== session.user.id &&
    !hasAdminAccess(session.user) &&
    !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // A soft-deleted booking is NOT FOUND here, for every caller — no Full Admin
  // exemption. Three reasons it is shaped this way:
  //
  //  - It is the pattern its own neighbours already use. `send-guest-payment-link`
  //    and `additional-payment-secret` both select `deletedAt` beside the
  //    authority fields and answer 404 on a deleted booking regardless of role.
  //  - It deliberately does NOT copy `bookings/[id]/page.tsx`'s
  //    `if (booking.deletedAt && !isAdmin) notFound()`. That exemption exists
  //    because the PAGE is a record-viewing surface, and an admin has a real
  //    reason to look at a booking that was deleted. This route is not a
  //    viewing surface: it exists solely to populate the requested-room picker,
  //    and that picker is hard-disabled on a deleted booking for every role
  //    (`canEditRequestedRoom` is `isDeleted ? false : ...`). Nobody of any role
  //    can act on this answer, so nobody of any role should receive it.
  //  - It sits AFTER the authority check, not before it. Checking deletion first
  //    would answer 404 for a deleted booking and 403 for a live one, handing an
  //    unauthorised caller a deleted-or-live oracle on a booking they have no
  //    claim to. This way an unauthorised caller gets 403 either way, and only
  //    someone entitled to the booking learns its state.
  if (booking.deletedAt) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.bedAllocation) {
    return NextResponse.json({ enabled: false, rooms: [] });
  }

  const rooms = await prisma.lodgeRoom.findMany({
    where: {
      active: true,
      // Server-derived, from the booking row read above. The only lodge scope
      // this route can ever apply.
      ...lodgeNullTolerantScope(booking.lodgeId),
    },
    include: {
      beds: { where: { active: true }, select: { id: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
  });

  return NextResponse.json({
    enabled: true,
    rooms: rooms.map((room) => ({
      id: room.id,
      name: room.name,
      bedCount: room.beds.length,
    })),
  });
}
