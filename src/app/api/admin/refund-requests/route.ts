import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "PENDING";

  const requests = await prisma.refundRequest.findMany({
    where: status === "ALL" ? {} : { status: status as "PENDING" | "APPROVED" | "REJECTED" },
    include: {
      booking: {
        select: {
          id: true,
          checkIn: true,
          checkOut: true,
          finalPriceCents: true,
          status: true,
          payment: {
            select: {
              amountCents: true,
              refundedAmountCents: true,
              stripePaymentIntentId: true,
            },
          },
        },
      },
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(requests);
}
