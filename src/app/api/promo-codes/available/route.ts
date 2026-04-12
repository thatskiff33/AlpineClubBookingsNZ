import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const memberId = session.user.id;
  const now = new Date();

  // Find promo codes assigned to this member that are still valid
  const assignments = await prisma.promoCodeAssignment.findMany({
    where: { memberId },
    include: {
      promoCode: true,
    },
  });

  const availableCodes = assignments
    .map((a) => a.promoCode)
    .filter((pc) => {
      if (!pc.active || pc.archivedAt) return false;
      if (pc.validFrom && now < pc.validFrom) return false;
      if (pc.validUntil && now >= pc.validUntil) return false;
      if (pc.maxRedemptions !== null && pc.currentRedemptions >= pc.maxRedemptions) return false;
      return true;
    })
    .map((pc) => ({
      code: pc.code,
      description: pc.description,
      type: pc.type,
      percentOff: pc.percentOff,
      valueCents: pc.valueCents,
      freeNights: pc.freeNights,
    }));

  return NextResponse.json(availableCodes);
}
