import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const where: Record<string, unknown> = {
    status: { in: [BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED] },
  };

  if (from || to) {
    if (from) {
      where.checkIn = { ...(where.checkIn as object || {}), gte: new Date(from) };
    }
    if (to) {
      where.checkOut = { ...(where.checkOut as object || {}), lte: new Date(to) };
    }
  }

  const bookings = await prisma.booking.findMany({
    where,
    include: {
      member: { select: { id: true, firstName: true, lastName: true, email: true } },
      guests: { select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const entries = bookings.map((b) => ({
    id: b.id,
    memberName: `${b.member.firstName} ${b.member.lastName}`,
    memberEmail: b.member.email,
    memberId: b.member.id,
    checkIn: b.checkIn.toISOString().split("T")[0],
    checkOut: b.checkOut.toISOString().split("T")[0],
    guestCount: b.guests.length,
    guests: b.guests,
    status: b.status,
    waitlistPosition: b.waitlistPosition,
    waitlistOfferExpiresAt: b.waitlistOfferExpiresAt?.toISOString() || null,
    finalPriceCents: b.finalPriceCents,
    createdAt: b.createdAt.toISOString(),
  }));

  return NextResponse.json({ entries, total: entries.length });
}
