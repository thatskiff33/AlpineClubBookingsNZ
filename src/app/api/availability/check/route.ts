import { NextRequest, NextResponse } from "next/server";
import { checkCapacity, getLodgeCapacity } from "@/lib/capacity";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { isMemberEligibleToBookLodge } from "@/lib/lodge-access";
import { getDefaultLodgeId } from "@/lib/lodges";
import { z } from "zod";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const availabilityCheckQuerySchema = z.object({
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  lodgeId: z.string().min(1).optional(),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const parsed = availabilityCheckQuerySchema.safeParse({
    checkIn: request.nextUrl.searchParams.get("checkIn"),
    checkOut: request.nextUrl.searchParams.get("checkOut"),
    lodgeId: request.nextUrl.searchParams.get("lodgeId") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn, checkOut, lodgeId: requestedLodgeId } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "checkOut must be after checkIn" }, { status: 400 });
  }

  let lodgeId: string;
  if (requestedLodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: requestedLodgeId },
      select: { id: true, active: true },
    });
    if (!lodge || !lodge.active) {
      return NextResponse.json({ error: "Unknown or inactive lodgeId" }, { status: 400 });
    }
    lodgeId = lodge.id;
  } else {
    lodgeId = await getDefaultLodgeId(prisma);
  }

  // A BOOKING_RESTRICTION-ed member must not read a forbidden lodge's
  // availability, mirroring the booking create path (assertMemberMayBookLodge).
  if (!(await isMemberEligibleToBookLodge(prisma, session.user.id, lodgeId))) {
    return NextResponse.json(
      { error: "This member cannot book the selected lodge." },
      { status: 403 }
    );
  }

  const [result, lodgeCapacity] = await Promise.all([
    checkCapacity(lodgeId, checkIn, checkOut, 1),
    getLodgeCapacity(lodgeId),
  ]);

  return NextResponse.json({
    // The SELECTED lodge's effective capacity (#2930). Sent explicitly because
    // every client of this route needs the denominator and the alternative is
    // the club-identity figure, which is one lodge's number used for all of
    // them: a capped or secondary lodge then renders free-bed counts and
    // fullness against the wrong ceiling. `getLodgeCapacity` is the one
    // resolver (`INV-CAP-003`) and this is the same value `checkCapacity`
    // computed its own `availableBeds` from, so the two cannot disagree.
    //
    // It discloses nothing a member could not already derive: the #155 payload
    // contract makes `occupiedBeds + availableBeds === lodgeCapacity` true on
    // EVERY night including a held one, which is exactly why the derivation is
    // safe and why stating it is too.
    lodgeCapacity,
    minAvailable: result.minAvailable,
    // `wholeLodgeHeld` is deliberately NOT projected. `checkCapacity` has
    // already pinned a held night to a full lodge at zero available beds
    // (`INV-CAP-021`, `INV-CAP-038`, ADR-001 decision 6), so what a member
    // reads here is byte-identical for a held night and a genuinely full one.
    // Adding the flag would hand back the distinction the pin exists to remove.
    nightDetails: result.nightDetails.map((n) => ({
      date: formatDateOnly(n.date),
      occupiedBeds: n.occupiedBeds,
      availableBeds: n.availableBeds,
    })),
  });
}
