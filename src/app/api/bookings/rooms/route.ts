import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  getEligibleLodgeIdsForMember,
  isMemberEligibleToBookLodge,
} from "@/lib/lodge-access";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { bookingRoomsQuerySchema } from "@/lib/booking-stay-check-query";
import { LODGE_ROOMS_CONNECTION_SHAPE } from "@/lib/connection-shapes-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";

/** Also the AI app action `list_lodge_rooms` (ALP-794). */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // An empty `lodgeId` lists across lodges, as it always has.
  const parsed = bookingRoomsQuerySchema.safeParse({
    lodgeId: request.nextUrl.searchParams.get("lodgeId") || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.bedAllocation) {
    return connectionJson(request, { enabled: false, rooms: [] }, LODGE_ROOMS_CONNECTION_SHAPE);
  }

  // Room preferences are per lodge (multi-lodge phase 8): the booking flow
  // passes its chosen lodge so members only see that lodge's rooms.
  // (LodgeRoom.lodgeId is NOT NULL since migration 20260708001100; the old
  // null-lodge expand-release tolerance no longer applies.)
  const { lodgeId } = parsed.data;
  // A BOOKING_RESTRICTION-ed member must not read a forbidden lodge's rooms,
  // mirroring the booking create path — whether they name the lodge or list
  // across lodges. Both branches gate on the same eligibility rule (item 6 of
  // #1587): a named forbidden lodge 403s (an access-denied on a named
  // resource); the cross-lodge listing is filtered to the member's eligible
  // lodges (a listing omits what the member cannot see, never 403 — matching
  // /api/lodges). The two sets are identical by construction because both
  // derive from getEligibleLodgeIdsForMember.
  let lodgeScope: {
    lodgeId?: string | { in: string[] };
    lodge?: { active: true };
  } = {};
  if (lodgeId) {
    if (!(await isMemberEligibleToBookLodge(prisma, session.user.id, lodgeId))) {
      return NextResponse.json(
        { error: "This member cannot book the selected lodge." },
        { status: 403 }
      );
    }
    lodgeScope = lodgeNullTolerantScope(lodgeId);
  } else {
    const eligible = await getEligibleLodgeIdsForMember(
      prisma,
      session.user.id
    );
    // An unrestricted member (default-open) sees every active lodge's rooms; a
    // restricted member sees only their eligible lodges (empty when none of
    // those lodges have active rooms).
    if (!eligible.allLodges) {
      lodgeScope = { lodgeId: { in: eligible.lodgeIds } };
    }
    // ARCHIVED LODGES ARE NEVER OFFERED HERE (#2727, INV-INT-016). This branch
    // is discovery — "where could I book?" — and a club archives a lodge when
    // it is closed, sold, out of service or seasonally shut, so listing its
    // rooms invites a member to try somewhere the club has deliberately taken
    // out of service. It applies to BOTH eligibility shapes above: a
    // default-open member's club-wide listing, and a restricted member whose
    // BOOKING_RESTRICTION rows happen to name a lodge that was later archived.
    // It is deliberately NOT applied to the named-lodge branch above, which is
    // scoped by an id the caller already holds rather than a discovery listing.
    lodgeScope.lodge = { active: true };
  }
  const rooms = await prisma.lodgeRoom.findMany({
    where: {
      active: true,
      ...lodgeScope,
    },
    include: {
      beds: { where: { active: true }, select: { id: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
  });

  return connectionJson(request, {
    enabled: true,
    rooms: rooms.map((room) => ({
      id: room.id,
      name: room.name,
      bedCount: room.beds.length,
    })),
  }, LODGE_ROOMS_CONNECTION_SHAPE);
}
