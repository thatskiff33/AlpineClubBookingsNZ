/**
 * The signed-in member's own whole-lodge requests (#2263, D3): the one read
 * the My bookings page and `GET /api/booking-requests/whole-lodge` (the AI app
 * action `list_my_whole_lodge_requests`, ALP-797) share, so the two cannot
 * select or reduce a request differently (`INV-SSOT`).
 *
 * Scoped by `requestedByMemberId` + `exclusivityRequested`, and projected
 * through `toMyWholeLodgeRequestItem`, the ONE place a request row is reduced
 * to something a member may see (strict allowlist + exhaustive status
 * mapping).
 */
import "server-only";

import {
  MY_WHOLE_LODGE_REQUEST_LIMIT,
  toMyWholeLodgeRequestItem,
  type MyWholeLodgeRequestItem,
} from "@/lib/member-whole-lodge-requests";
import { prisma } from "@/lib/prisma";

export async function loadMyWholeLodgeRequests(memberId: string): Promise<MyWholeLodgeRequestItem[]> {
  const rows = await prisma.bookingRequest.findMany({
    where: {
      requestedByMemberId: memberId,
      exclusivityRequested: true,
    },
    select: {
      id: true,
      status: true,
      checkIn: true,
      checkOut: true,
      createdAt: true,
      convertedBookingId: true,
      heldBookingId: true,
      guests: true,
    },
    orderBy: { createdAt: "desc" },
    take: MY_WHOLE_LODGE_REQUEST_LIMIT,
  });

  return rows.map((row) =>
    toMyWholeLodgeRequestItem({
      ...row,
      guestCount: Array.isArray(row.guests) ? row.guests.length : 0,
    }),
  );
}
